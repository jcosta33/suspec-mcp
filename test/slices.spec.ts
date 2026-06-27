import { describe, it, expect } from "vitest";

import {
  slice_status,
  slice_file_check,
  slice_workspace_check,
  slice_show_task,
  slice_show_spec,
  slice_show_review,
  slice_show_checks,
  list_from_board,
} from "../src/slices.ts";

// The concise projections (AC-013) are pure shape reducers: they keep the identifiers + triage fields and
// drop the prose/line-numbers/evidence. These tests assert (1) the happy-path slice drops the right fields
// and keeps the right ones, AND (2) every defensive fallback arm — a malformed/non-object payload returns
// the verbatim data rather than throwing (concise must never become a second failure mode; the contract
// tripwire owns drift-detection).

describe("slice_status", () => {
  it("keeps spec/task ids + reviewStatus + the triage lists; collapses each task", () => {
    const out = slice_status({
      level: "clean",
      specs: [
        {
          id: "SPEC-x",
          status: "ready",
          tasks: [
            { id: "TASK-x", status: "ready", hasReview: true, reviewStatus: "pass", extra: "drop-me" },
          ],
        },
      ],
      tasksWithoutReview: ["T"],
      needsHuman: [],
    }) as { specs: { tasks: { id: string }[] }[] };
    expect(out.specs[0].tasks[0]).toEqual({ id: "TASK-x", reviewStatus: "pass" });
  });

  it("falls back to verbatim data on a non-object payload, and tolerates a non-object spec/task", () => {
    expect(slice_status("not an object")).toBe("not an object");
    // a malformed spec / task entry exercises the `as_obj(...) ?? {}` arms without throwing
    const out = slice_status({ specs: [null, { tasks: [null] }] }) as {
      specs: { id: undefined; tasks: { id: undefined }[] }[];
    };
    expect(out.specs[0].id).toBeUndefined();
    expect(out.specs[1].tasks[0].id).toBeUndefined();
  });
});

describe("slice_file_check", () => {
  it("keeps level + diagnostic triple; drops path + line", () => {
    const out = slice_file_check({
      level: "warning",
      path: "specs/a/spec.md",
      diagnostics: [{ code: "C004", severity: "warning", message: "demo", line: 1 }],
    }) as { level: string; diagnostics: { code: string; line?: number }[] };
    expect(out.level).toBe("warning");
    expect(out.diagnostics[0]).toEqual({ code: "C004", severity: "warning", message: "demo" });
    expect("line" in out.diagnostics[0]).toBe(false);
  });

  it("falls back on a non-object payload and tolerates a malformed diagnostic", () => {
    expect(slice_file_check(42)).toBe(42);
    const out = slice_file_check({ diagnostics: [null] }) as { diagnostics: unknown[] };
    expect(out.diagnostics).toHaveLength(1);
  });
});

describe("slice_workspace_check", () => {
  it("keeps the verdict + ONLY the artifacts that carry a diagnostic", () => {
    const out = slice_workspace_check({
      level: "warning",
      verdict: "clean",
      specs: [
        { path: "clean.md", level: "clean", diagnostics: [] },
        { path: "bad.md", level: "warning", diagnostics: [{ code: "C004", severity: "warning", message: "x" }] },
      ],
      changePlans: [{ path: "cp.md", level: "clean", diagnostics: [] }],
      workspaceFindings: [{ code: "duplicate-content", message: "y" }],
    }) as { specs: { path: string }[]; changePlans: unknown[] };
    expect(out.specs.map((s) => s.path)).toEqual(["bad.md"]); // the clean one is dropped
    expect(out.changePlans).toEqual([]);
  });

  it("falls back on a non-object payload and tolerates a malformed spec/diagnostic", () => {
    expect(slice_workspace_check(null)).toBe(null);
    const out = slice_workspace_check({
      specs: [{ diagnostics: [null] }],
      changePlans: [],
    }) as { specs: unknown[] };
    expect(out.specs).toHaveLength(1);
  });
});

describe("slice_show_task", () => {
  it("keeps the scope-bearing identity; drops doNotChange / claimedChangedFiles / embeddedRequirements", () => {
    const out = slice_show_task({
      kind: "task",
      value: {
        id: "TASK-x",
        source: "SPEC-x",
        status: "ready",
        scope: ["AC-001"],
        affectedAreas: ["src"],
        doNotChange: ["frozen.ts"],
        claimedChangedFiles: ["a.ts"],
        embeddedSpecId: "SPEC-x",
        embeddedRequirements: [{ id: "AC-001", verifyCommand: null }],
      },
    }) as { value: Record<string, unknown> };
    expect(Object.keys(out.value).sort()).toEqual(
      ["affectedAreas", "embeddedSpecId", "id", "scope", "source", "status"].sort(),
    );
  });

  it("falls back when there is no value object (non-object payload, or value missing)", () => {
    expect(slice_show_task("x")).toBe("x");
    const noValue = { kind: "task" };
    expect(slice_show_task(noValue)).toBe(noValue);
  });
});

describe("slice_show_spec", () => {
  it("keeps id/status + requirement IDS + section titles; drops execution prose + line numbers", () => {
    const out = slice_show_spec({
      kind: "spec",
      value: {
        frontmatter: { id: "SPEC-x", status: "ready" },
        requirements: [{ id: "AC-001", line: 5, verifyCommand: "t" }],
        sectionTitles: ["Requirements"],
        openQuestionsPresent: true,
        execution: "a long run record",
      },
    }) as { value: { id: string; requirements: unknown[]; hasExecution: boolean } };
    expect(out.value.id).toBe("SPEC-x");
    expect(out.value.requirements).toEqual(["AC-001"]); // ids only — no line/verify
    expect(out.value.hasExecution).toBe(true);
  });

  it("hasExecution is false when execution is null, and falls back without a value", () => {
    const out = slice_show_spec({
      kind: "spec",
      value: { frontmatter: { id: "SPEC-y", status: "draft" }, requirements: [], sectionTitles: [], execution: null },
    }) as { value: { hasExecution: boolean } };
    expect(out.value.hasExecution).toBe(false);
    expect(slice_show_spec(123)).toBe(123);
  });
});

describe("slice_show_review", () => {
  it("keeps status + coverage {id,result} + verify {id,result} + the spec/task identity; drops evidence + pins", () => {
    const out = slice_show_review({
      kind: "review",
      value: {
        status: "needs-human",
        coverageRows: [{ id: "AC-001", result: "Pass", evidence: "pasted-proof" }],
        verifyBlocks: [{ id: "AC-001", cmd: "t", result: "pass", malformed: false }],
        frontmatter: { status: "needs-human", spec: "SPEC-x", task: "TASK-x", reviewedSha: "abc", evidenceHash: "def" },
      },
    }) as {
      value: { coverageRows: Record<string, unknown>[]; reviews: { spec: string; task: string } };
    };
    expect("evidence" in out.value.coverageRows[0]).toBe(false);
    expect(out.value.reviews).toEqual({ spec: "SPEC-x", task: "TASK-x" });
  });

  it("falls back without a value, and tolerates a malformed row", () => {
    expect(slice_show_review(false)).toBe(false);
    const out = slice_show_review({ kind: "review", value: { coverageRows: [null], verifyBlocks: [null] } }) as {
      value: { coverageRows: unknown[] };
    };
    expect(out.value.coverageRows).toHaveLength(1);
  });
});

describe("slice_show_checks", () => {
  it("keeps version + each check {id, severity}; drops the human name", () => {
    const out = slice_show_checks({
      kind: "checks",
      value: {
        version: "0.9.0",
        checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
      },
    }) as { value: { version: string; checks: Record<string, unknown>[] } };
    expect(out.value.version).toBe("0.9.0");
    expect(out.value.checks[0]).toEqual({ id: "C001", severity: "hard-error" });
  });

  it("falls back without a value, and tolerates a malformed check", () => {
    expect(slice_show_checks(undefined)).toBe(undefined);
    const out = slice_show_checks({ kind: "checks", value: { checks: [null] } }) as {
      value: { checks: unknown[] };
    };
    expect(out.value.checks).toHaveLength(1);
  });
});

describe("list_from_board (AC-012)", () => {
  const board = {
    level: "clean",
    specs: [
      {
        id: "SPEC-x",
        status: "ready",
        tasks: [{ id: "TASK-x", status: "ready", hasReview: true, reviewStatus: "pass" }],
      },
      { id: "SPEC-y", status: "draft", tasks: [] },
    ],
    tasksWithoutReview: [],
    needsHuman: [],
  };

  it("kind:specs → spec ids + status", () => {
    const out = list_from_board(board, "specs") as {
      kind: string;
      specs: { id: string; status: string }[];
    };
    expect(out.kind).toBe("specs");
    expect(out.specs).toEqual([
      { id: "SPEC-x", status: "ready" },
      { id: "SPEC-y", status: "draft" },
    ]);
  });

  it("kind:tasks → every task across all specs, with its spec + review status", () => {
    const out = list_from_board(board, "tasks") as {
      kind: string;
      tasks: { id: string; spec: string; reviewStatus: string }[];
    };
    expect(out.kind).toBe("tasks");
    expect(out.tasks).toEqual([
      { id: "TASK-x", spec: "SPEC-x", status: "ready", hasReview: true, reviewStatus: "pass" },
    ]);
  });

  it("falls back to verbatim on a non-object board, and tolerates malformed spec/task entries", () => {
    expect(list_from_board("not a board", "specs")).toBe("not a board");
    const out = list_from_board({ specs: [null, { tasks: [null] }] }, "tasks") as {
      tasks: { id: undefined }[];
    };
    expect(out.tasks[0].id).toBeUndefined();
  });
});
