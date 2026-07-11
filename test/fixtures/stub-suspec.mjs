#!/usr/bin/env node
// A stub `suspec` binary for deterministic, offline suspec-mcp tests — the path-explicit check
// surface. Records every invocation's argv to STUB_LOG (so tests can assert which subprocesses ran /
// that no mutation flag was ever passed) and emits JSON to stdout mirroring the real CLI's --json
// shapes. Like the real CLI, it reads the checked file itself: the kind sniff comes from the file's
// frontmatter `type:`, and a review packet enforces the companion rules (--spec always; --task iff
// the review names a `task:`; companions belong to a review and must exist on disk), so the
// adapter's companion plumbing is exercised end to end.
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
}
// Make the no-write test non-circular: if a mutation/dispatch-shaped flag is EVER passed, drop a marker
// into the workspace (cwd). The test then asserts the marker never appears — a real failure if the
// adapter leaks such a flag, not a tautology about a non-writing stub.
if (
  argv.some(
    (a) => a === "--write" || a === "--force" || a === "--agent" || a === "--launch",
  )
) {
  appendFileSync(join(process.cwd(), "WRITE-FLAG-SEEN"), "1");
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const fail = (message) => {
  emit({ error: "Usage", message });
  process.exit(2);
};
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const verb = argv[0];
if (verb !== "check") {
  fail(`unknown verb: ${verb}`);
}

if (argv.includes("--contract")) {
  emit({
    version: "0.16.0",
    checks: [
      { id: "C001", name: "unique-ids", severity: "hard-error" },
      { id: "C004", name: "one-strength-word", severity: "warning" },
    ],
  });
  process.exit(0);
}

// Positional extraction mirroring the real CLI's flag parser: `--spec`/`--task` consume a value.
const VALUED = new Set(["--spec", "--task"]);
const positionals = [];
for (let i = 1; i < argv.length; i += 1) {
  const token = argv[i];
  if (token.startsWith("--")) {
    if (VALUED.has(token)) {
      i += 1;
    }
    continue;
  }
  positionals.push(token);
}
const file = positionals[0];
if (!file) {
  fail("no artifact named — usage: suspec check <artifact> [<artifact>...]");
}
if (!existsSync(file)) {
  fail(`file not found: ${file}`);
}
if (statSync(file).isDirectory()) {
  fail(`not an artifact file (it is a directory): ${file} — point at the file inside it`);
}
const source = readFileSync(file, "utf8");
const head = source.split(/\r?\n/).slice(0, 12).join("\n");
const type = /^type:\s*(.+?)\s*$/m.exec(head)?.[1] ?? null;

// The companion flags belong to a review and nothing else, mirrored from the real CLI.
if (type !== "review" && (flag("--spec") !== undefined || flag("--task") !== undefined)) {
  fail(
    "--spec/--task accompany a review packet — the named artifacts carry no review",
  );
}

if (type === "review") {
  // The companion rules, mirrored from the real CLI (its messages verbatim).
  if (flag("--spec") === undefined) {
    fail(
      "a review packet needs its source spec: missing --spec — usage: suspec check <review-path> --spec <spec-path> [--task <task-path>]",
    );
  }
  // A handed companion must exist on disk — checked before the task-reference rules, like the CLI.
  for (const name of ["--spec", "--task"]) {
    const companion = flag(name);
    if (companion !== undefined && !existsSync(companion)) {
      fail(`${name} file not found: ${companion}`);
    }
  }
  const taskRef = /^task:\s*(.+?)\s*$/m.exec(head)?.[1];
  const task = flag("--task");
  if (taskRef !== undefined && task === undefined) {
    fail(
      `the review names task \`${taskRef}\`: missing --task — usage: suspec check <review-path> --spec <spec-path> --task <task-path>`,
    );
  }
  if (taskRef === undefined && task !== undefined) {
    fail(
      "--task names a packet but the review references no task (no `task:` frontmatter) — a companion nothing references is a wiring mistake",
    );
  }
  emit({ path: file, level: "clean", diagnostics: [] });
  process.exit(0);
}

// An artifact whose type has NO check face: the CLI says so cleanly and exits 0.
if (type !== null && type !== "spec" && type !== "change-plan") {
  emit({ level: "clean", path: file, type, checked: false });
  process.exit(0);
}

// A spec / change-plan / type-less file: a deterministic one-warning report (exit 1, the CLI's
// warnings exit).
emit({
  level: "warning",
  path: file,
  diagnostics: [{ code: "C004", severity: "warning", message: "demo", line: 1 }],
});
process.exit(1);
