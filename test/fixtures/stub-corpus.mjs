#!/usr/bin/env node
// A stub `corpus` binary for deterministic, offline corpus-mcp tests. Records every invocation's argv to
// STUB_LOG (so tests can assert which subprocesses ran / that no write flag was ever passed) and emits
// fixture JSON to stdout keyed off the verb — mirroring the real CLI's --json shapes.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
}
// Make the no-write test non-circular: if a write/mutation flag is EVER passed, drop a marker into the
// workspace (cwd). The test then asserts the marker never appears — a real failure if the adapter leaks
// a write flag, not a tautology about a non-writing stub.
if (argv.some((a) => a === "--write" || a === "--force" || a === "--agent")) {
  appendFileSync(join(process.cwd(), "WRITE-FLAG-SEEN"), "1");
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const verb = argv[0];
const positionals = argv.slice(1).filter((a) => !a.startsWith("--"));

if (verb === "status") {
  emit({
    level: "clean",
    specs: [
      {
        id: "SPEC-x",
        status: "ready",
        tasks: [
          {
            id: "TASK-x",
            status: "ready",
            hasReview: true,
            reviewStatus: "pass",
          },
        ],
      },
    ],
    tasksWithoutReview: [],
    needsHuman: [],
  });
} else if (verb === "check") {
  const path = positionals[0];
  if (path) {
    emit({
      level: "warning",
      path,
      diagnostics: [
        { code: "C004", severity: "warning", message: "demo", line: 1 },
      ],
    });
  } else {
    emit({
      level: "clean",
      verdict: "clean",
      specs: [{ path: "specs/a/spec.md", level: "clean", diagnostics: [] }],
      changePlans: [
        { path: "change-plans/p.md", level: "clean", diagnostics: [] },
      ],
      workspaceFindings: [],
    });
  }
} else if (verb === "review") {
  const stem = positionals[0];
  if (stem === "noworktree") {
    process.stdout.write(
      JSON.stringify({
        error: "Usage",
        message: `no worktree found for ${stem} — launch the run before reviewing it`,
      }),
    );
    process.exit(2);
  }
  emit({
    level: "warning",
    task: stem,
    diffChangedFiles: ["src/a.ts", "package-lock.json"],
    // The message is single-sourced in the CLI (checksContract.ts `coverage_message`) and ends with the
    // `(uncovered)` / `(orphan)` kind suffix — the stub mirrors that exact wording.
    coverage: [
      {
        id: "AC-002",
        kind: "uncovered",
        message:
          "requirement AC-002 is in scope but has no coverage row (uncovered)",
      },
    ],
    verifyBinding: [
      {
        id: "AC-003",
        kind: "cmd-mismatch",
        message: "verify block cmd does not match the requirement command",
      },
    ],
    scopeDivergence: [],
    selfReport: {
      claimedNotInDiff: [],
      inDiffNotClaimed: ["package-lock.json"],
      outsideScope: ["package-lock.json"],
    },
    doNotChangeTouched: ["src/auth/token-family.ts"],
    emptyEvidencePassRows: ["AC-004"],
    packetStructural: {
      badResultCells: [],
      badStatus: null,
      statusPassContradicted: false,
      missingSections: [],
    },
    hasReviewPacket: true,
  });
} else if (verb === "show") {
  const kind = positionals[0];
  const ref = positionals[1];
  if (kind === "checks") {
    emit({
      level: "clean",
      kind: "checks",
      value: {
        version: "0.6.0",
        checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
      },
    });
  } else if (kind === "task" && ref) {
    emit({
      level: "clean",
      kind: "task",
      value: {
        id: `TASK-${ref}`,
        source: "SPEC-x",
        status: "ready",
        scope: ["AC-001"],
        affectedAreas: ["src"],
        claimedChangedFiles: [],
      },
    });
  } else if (kind === "spec" && ref) {
    emit({
      level: "clean",
      kind: "spec",
      value: {
        frontmatter: {
          type: "spec",
          id: ref,
          status: "ready",
          format: null,
          sources: [],
        },
        requirements: [{ id: "AC-001", line: 5, verifyCommand: "a test" }],
        sectionTitles: ["Requirements"],
        openQuestionsPresent: false,
      },
    });
  } else if (kind === "review" && ref) {
    emit({
      level: "clean",
      kind: "review",
      value: {
        status: "needs-human",
        sectionTitles: ["Requirement coverage"],
        coverageRows: [{ id: "AC-001", result: "Pass", evidence: "pasted" }],
        verifyBlocks: [],
      },
    });
  } else {
    process.stdout.write(
      JSON.stringify({
        error: "Usage",
        message: `cannot show ${kind} ${ref ?? ""}`,
      }),
    );
    process.exit(2);
  }
} else {
  process.stdout.write(
    JSON.stringify({ error: "Usage", message: `unknown verb: ${verb}` }),
  );
  process.exit(2);
}
