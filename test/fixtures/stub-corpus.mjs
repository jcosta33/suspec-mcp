#!/usr/bin/env node
// A stub `corpus` binary for deterministic, offline corpus-mcp tests. Records every invocation's argv to
// STUB_LOG (so tests can assert which subprocesses ran / that no write flag was ever passed) and emits
// fixture JSON to stdout keyed off the verb — mirroring the real CLI's --json shapes.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

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
        doNotChange: [],
        claimedChangedFiles: [],
        embeddedSpecId: null,
        embeddedRequirements: [],
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
        sectionTitles: ["Requirements", "Execution"],
        openQuestionsPresent: false,
        execution: "- 2026-06-26 — v0 shipped.",
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
        frontmatter: {
          status: "needs-human",
          spec: null,
          task: `TASK-${ref}`,
          pr: null,
          reviewedSha: null,
          evidenceHash: null,
        },
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
} else if (verb === "new") {
  // The verdict-free safe-write tier: `new spec <slug>` and `new task --from <SPEC> [--scope …]`. The
  // stub WRITES a scaffold file (mirroring the real CLI) so the safe-write test can assert one appeared,
  // then emits the report shape. It never overwrites and never emits a verdict.
  const type = positionals[0];
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (type === "spec") {
    const slug = positionals[1];
    if (!slug) {
      process.stdout.write(
        JSON.stringify({ error: "Usage", message: "new spec needs a slug" }),
      );
      process.exit(2);
    }
    const path = join(process.cwd(), "specs", slug, "spec.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\ntype: spec\nid: SPEC-${slug}\n---\n# ${slug}\n`);
    emit({ level: "clean", path, specId: `SPEC-${slug}` });
  } else if (type === "task") {
    const from = flag("--from");
    if (!from) {
      process.stdout.write(
        JSON.stringify({
          error: "Usage",
          message: "new task needs --from <SPEC-id>",
        }),
      );
      process.exit(2);
    }
    const scopeFlag = flag("--scope");
    const scope =
      typeof scopeFlag === "string" && scopeFlag.length > 0
        ? scopeFlag.split(",")
        : [];
    const taskId = `TASK-${from.replace(/^SPEC-/i, "").toLowerCase()}`;
    const path = join(process.cwd(), "tasks", `${taskId}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\ntype: task\nid: ${taskId}\nsource: ${from}\n---\n`);
    emit({ level: "clean", path, taskId, scope });
  } else {
    process.stdout.write(
      JSON.stringify({ error: "Usage", message: `unknown new type: ${type}` }),
    );
    process.exit(2);
  }
} else if (verb === "promote") {
  // `promote <task>` scaffolds one candidate finding (no learning asserted, no board, no verdict).
  const task = positionals[0];
  if (!task) {
    process.stdout.write(
      JSON.stringify({ error: "Usage", message: "promote needs a task id" }),
    );
    process.exit(2);
  }
  const slug = task.replace(/^(?:TASK|REVIEW|AUDIT|INV)-/i, "").toLowerCase();
  const path = join(process.cwd(), "findings", `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ntype: finding\nid: FINDING-${slug}\nstatus: candidate\nfrom: ${task}\n---\n`);
  emit({ level: "clean", path, slug, from: task });
} else {
  process.stdout.write(
    JSON.stringify({ error: "Usage", message: `unknown verb: ${verb}` }),
  );
  process.exit(2);
}
