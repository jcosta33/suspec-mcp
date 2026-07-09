#!/usr/bin/env node
// Regenerate the contract fixtures from the REAL `suspec` binary (the v2 STORE surface, ADR-0137). The
// fixtures in test/fixtures/*.json are the drift tripwire's ground truth: contract.spec.ts parses each
// through the contract schemas, so a fixture that drifts from reality (or a schema that drifts from the
// fixture) fails a test instead of suspec-mcp silently producing wrong output. They MUST be generated,
// not hand-edited — this script is the generator, and test/generated-fixtures.spec.ts re-runs it into a
// temp dir and asserts the checked-in fixtures still match (so a stale fixture trips CI).
//
// It builds a deterministic, self-contained scratch REPO + STORE (git init → `write spec` → author a
// ready 2-AC spec in the store → `new task` → a run record → one real `evidence add` capture) so it can
// capture EVERY `--json` shape the adapter consumes — including a real run review (verified + missing
// evidence rows and a gate gap). The store is confined to the scratch dir via SUSPEC_STATE_DIR, so the
// generator never touches the developer's real ~/.claude/state. The run record is hand-written the same
// way suspec-cli's own command tests seed one (`work` would dispatch a live runner — not viable here).
//
// Usage:  node scripts/generate-fixtures.mjs [--out <dir>] [--suspec-bin <path>]
//   --out        where to write the fixtures (default: test/fixtures next to this script's repo)
//   --suspec-bin the `suspec` binary (default: SUSPEC_BIN env, else any sibling checkout whose
//                package name is "suspec-cli" — the folder name is irrelevant; see resolve-suspec-bin.mjs)

import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSuspecBin } from "./resolve-suspec-bin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]
    : fallback;
}

const outDir = resolve(arg("--out", join(repoRoot, "test", "fixtures")));
const suspecBinArg = arg("--suspec-bin", null);
const suspecBin = suspecBinArg ? resolve(suspecBinArg) : resolveSuspecBin(repoRoot);
if (!suspecBin) {
  console.error(
    "generate-fixtures: cannot find the suspec binary. Pass --suspec-bin <path>, set SUSPEC_BIN, " +
      "or check out suspec-cli as a sibling (any folder name; package name must be suspec-cli).",
  );
  process.exit(2);
}

let stateDir; // set in main(); every suspec invocation gets SUSPEC_STATE_DIR so the store stays scratch

// Run `suspec <args> --json` in `cwd`; return the parsed JSON (or throw a clear error). `--json` is the
// only flag this generator appends — BEFORE any `--` separator (after it, the CLI would record `--json`
// as part of an `evidence add` command). It never passes a mutation flag the adapter would not.
function suspec(cwd, args) {
  const sep = args.indexOf("--");
  const argv =
    sep === -1
      ? [...args, "--json"]
      : [...args.slice(0, sep), "--json", ...args.slice(sep)];
  const res = spawnSync(process.execPath, [suspecBin, ...argv], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SUSPEC_STATE_DIR: stateDir },
  });
  const stdout = (res.stdout ?? "").trim();
  if (stdout.length === 0) {
    throw new Error(
      `suspec ${args.join(" ")} produced no JSON (exit ${res.status}): ${(res.stderr ?? "").trim()}`,
    );
  }
  return JSON.parse(stdout);
}

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function write(name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(outDir, `${name}.json`), text);
  process.stderr.write(`  wrote ${name}.json\n`);
}

// A complete, READY spec with two ACs. `write spec` scaffolds a DRAFT skeleton (one empty AC) by
// design — a hand-authored ready spec lets the real `suspec review` produce genuine evidence rows for
// two ACs (one verified, one missing → a gate gap). This is still the REAL binary's output over a real
// store spec — only the spec INPUT is authored here, exactly as an author would after the scaffold.
const READY_SPEC = [
  "---",
  "type: spec",
  "id: SPEC-demo-feature",
  "title: Demo feature",
  "status: ready",
  "owner: fixtures",
  "base_sha: null",
  "sources:",
  "  - self",
  "---",
  "",
  "# Demo feature",
  "",
  "## Intent",
  "",
  "Add a demo feature so the fixtures exercise a real store reconcile.",
  "",
  "## Non-goals",
  "",
  "- It changes nothing in production.",
  "",
  "## Requirements",
  "",
  "### AC-001 — first",
  "",
  "When a request arrives, the service must respond.",
  "",
  "Verify with: `git --version`",
  "",
  "### AC-002 — second",
  "",
  "When a second request arrives, the service must also respond.",
  "",
  "Verify with: `second test`",
  "",
  "## Open questions",
  "",
  "- none",
  "",
  "## Affected areas",
  "",
  "- `src-file.txt`",
  "",
  "## Dropped from sources",
  "",
  "- none",
  "",
].join("\n");

function main() {
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "suspec-mcp-fixtures-"));
  try {
    process.stderr.write(`generating fixtures in ${scratch}\n`);
    stateDir = join(scratch, "state");
    const repo = join(scratch, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "fixtures@suspec.local"]);
    git(repo, ["config", "user.name", "fixtures"]);
    writeFileSync(join(repo, "src-file.txt"), "hello\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "scaffold"]);

    // 1. the SAFE-WRITE tier outputs, captured from the REAL prepare ops: the store spec scaffold and
    //    the store task slice. (`write spec` resolves the store on first use.)
    write("write-spec", suspec(repo, ["write", "spec", "demo feature"]));
    const storeDir = join(stateDir, "repo");

    // 2. author the scaffolded spec into a READY 2-AC spec (see READY_SPEC above).
    writeFileSync(join(storeDir, "spec-demo-feature.md"), READY_SPEC);
    write(
      "new-task",
      suspec(repo, [
        "new",
        "task",
        "--from",
        "SPEC-demo-feature",
        "--scope",
        "AC-001",
      ]),
    );

    // 3. a run record for the spec — hand-seeded the way suspec-cli's own done/review tests seed one
    //    (`suspec work` dispatches a live runner, which a fixture generator cannot). The worktree points
    //    at the scratch repo so `evidence add` has a real place to run its command.
    writeFileSync(
      join(storeDir, "run-demo.md"),
      [
        "---",
        "type: run",
        "spec: SPEC-demo-feature",
        `worktree: ${repo}`,
        "branch: suspec/demo",
        "status: exited",
        "---",
        "",
        "# Run",
        "",
        "agent notes",
        "",
      ].join("\n"),
    );

    // 4. ONE real cli-verified evidence capture (AC-001) — so the review fixture carries a `verified`
    //    row with a capture-backed record, alongside AC-002's `missing` row (a genuine gate gap).
    suspec(repo, [
      "evidence",
      "add",
      "demo",
      "--ac",
      "AC-001",
      "--",
      "git",
      "--version",
    ]);

    // 5. the READ-tier outputs.
    write("status", suspec(repo, ["status"]));
    write("store-list", suspec(repo, ["store", "list"]));
    write("check-store", suspec(repo, ["check"]));
    write(
      "check-file",
      suspec(repo, ["check", join(storeDir, "spec-demo-feature.md")]),
    );
    write("show-checks", suspec(repo, ["show", "checks"]));

    // 6. the run-vs-spec reconcile — the shape suspec_reconcile consumes (exit 1 here: AC-002 is a gap;
    //    the generator only needs the parseable stdout).
    write("review-report", suspec(repo, ["review", "demo"]));

    process.stderr.write(`done. fixtures in ${outDir}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
