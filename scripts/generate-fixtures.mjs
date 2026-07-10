#!/usr/bin/env node
// Regenerate the contract fixtures from the REAL `suspec` binary (the path-explicit check surface,
// ADR-0143). The fixtures in test/fixtures/*.json are the drift tripwire's ground truth:
// contract.spec.ts parses each through the contract schemas, so a fixture that drifts from reality
// (or a schema that drifts from the fixture) fails a test instead of suspec-mcp silently producing
// wrong output. They MUST be generated, not hand-edited — this script is the generator, and
// test/generated-fixtures.spec.ts re-runs it into a temp dir and asserts the checked-in fixtures
// still match (so a stale fixture trips CI).
//
// It builds a deterministic, self-contained scratch dir of artifacts (a spec, a task packet, a
// task-referencing review — clean and diagnostic-carrying variants) and captures EVERY `--json`
// shape the adapter consumes: the per-file check report, the unchecked-artifact notice, the checks
// contract, and the structured error the conditional-companion rule emits. Every path is passed
// RELATIVE with cwd=scratch, so the captured output is machine-independent (no absolute paths to
// normalize).
//
// Usage:  node scripts/generate-fixtures.mjs [--out <dir>] [--suspec-bin <path>]
//   --out        where to write the fixtures (default: test/fixtures next to this script's repo)
//   --suspec-bin the `suspec` binary (default: SUSPEC_BIN env, else any sibling checkout whose
//                package name is "suspec-cli" — the folder name is irrelevant; see resolve-suspec-bin.mjs)

import { spawnSync } from "node:child_process";
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

// Run `suspec <args> --json` in `cwd`; return the parsed JSON (or throw a clear error). Structured
// errors (an `{error, message}` body with exit 2) are as much a captured shape as a success report,
// so the parsed object is returned either way — the caller names what it expects.
function suspec(cwd, args) {
  const res = spawnSync(process.execPath, [suspecBin, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = (res.stdout ?? "").trim();
  if (stdout.length === 0) {
    throw new Error(
      `suspec ${args.join(" ")} produced no JSON (exit ${res.status}): ${(res.stderr ?? "").trim()}`,
    );
  }
  return JSON.parse(stdout);
}

function write(name, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(outDir, `${name}.json`), text);
  process.stderr.write(`  wrote ${name}.json\n`);
}

// A complete, ready 2-AC spec — the review's always-required companion, and the clean spec-check
// subject.
const SPEC = [
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
  "Add a demo feature so the fixtures exercise a real check.",
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

// The task packet the review names — its declared scope keys the review's coverage.
const TASK = [
  "---",
  "type: task",
  "id: TASK-demo",
  "source:",
  "  - SPEC-demo-feature",
  "scope: [AC-001]",
  "status: review-ready",
  "---",
  "",
  "# Task",
  "",
  "## Run summary",
  "",
].join("\n");

// A clean task-keyed review: the Pass row carries evidence and a verify block matching the spec's
// named command.
const REVIEW = [
  "---",
  "type: review",
  "id: REVIEW-demo",
  "task: TASK-demo",
  "status: needs-human",
  "---",
  "",
  "## Requirement coverage",
  "",
  "| ID | Result | Evidence | Human attention |",
  "|---|---|---|---|",
  "| AC-001 | Pass | p | no |",
  "",
  '```verify id=AC-001 cmd="git --version" result=pass',
  "ok",
  "```",
  "",
].join("\n");

// A diagnostic-carrying review: a Pass row with an EMPTY Evidence cell and no verify block, so the
// captured report pins the diagnostic fields (code/severity/message/line) with real check output.
const REVIEW_BAD = [
  "---",
  "type: review",
  "id: REVIEW-demo",
  "task: TASK-demo",
  "status: needs-human",
  "---",
  "",
  "## Requirement coverage",
  "",
  "| ID | Result | Evidence | Human attention |",
  "|---|---|---|---|",
  "| AC-001 | Pass |  | no |",
  "",
].join("\n");

function main() {
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "suspec-mcp-fixtures-"));
  try {
    process.stderr.write(`generating fixtures in ${scratch}\n`);
    writeFileSync(join(scratch, "spec-demo.md"), SPEC);
    writeFileSync(join(scratch, "task-demo.md"), TASK);
    writeFileSync(join(scratch, "review-demo.md"), REVIEW);
    writeFileSync(join(scratch, "review-bad.md"), REVIEW_BAD);

    // 1. the per-file check reports: a clean spec, a clean review (both companions), and a
    //    diagnostic-carrying review.
    write("check-spec", suspec(scratch, ["check", "spec-demo.md"]));
    write(
      "check-review",
      suspec(scratch, [
        "check",
        "review-demo.md",
        "--spec",
        "spec-demo.md",
        "--task",
        "task-demo.md",
      ]),
    );
    write(
      "check-review-diagnostics",
      suspec(scratch, [
        "check",
        "review-bad.md",
        "--spec",
        "spec-demo.md",
        "--task",
        "task-demo.md",
      ]),
    );

    // 2. an artifact whose type has no check face — the unchecked notice.
    write("check-unchecked", suspec(scratch, ["check", "task-demo.md"]));

    // 3. the checks contract.
    write("contract", suspec(scratch, ["check", "--contract"]));

    // 4. the structured error the conditional-companion rule emits: the review names a task, but no
    //    --task is handed — the CLI refuses (exit 2) instead of silently checking less.
    write(
      "error-missing-task",
      suspec(scratch, ["check", "review-demo.md", "--spec", "spec-demo.md"]),
    );

    process.stderr.write(`done. fixtures in ${outDir}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
