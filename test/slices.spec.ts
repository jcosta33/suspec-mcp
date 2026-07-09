import { describe, it, expect } from "vitest";

import {
  slice_status,
  slice_store_list,
  slice_store_lint,
  slice_file_check,
  slice_show_checks,
} from "../src/slices.ts";

// The concise projections (AC-013) are pure shape reducers: they keep the identifiers + triage fields and
// drop the archive noise / per-entry ages / clean-artifact echoes. These tests assert (1) the happy-path
// slice drops the right fields and keeps the right ones, AND (2) every defensive fallback arm — a
// malformed/non-object payload returns the verbatim data rather than throwing (concise must never become
// a second failure mode; the contract tripwire owns drift-detection).

describe("slice_status", () => {
  it("keeps the active artifacts + the full next ranking; drops the archived listing", () => {
    const out = slice_status({
      level: "clean",
      active: [
        { filename: "spec-x.md", kind: "spec", ageDays: 0, extra: "drop-me" },
      ],
      archived: [{ filename: "run-old.md", kind: "run", ageDays: 44 }],
      next: [
        { rank: 3, kind: "gate-gaps", ref: "feat", detail: "d", action: "a" },
      ],
    }) as { active: Record<string, unknown>[]; next: unknown[] };
    expect(out.active[0]).toEqual({
      filename: "spec-x.md",
      kind: "spec",
      ageDays: 0,
    });
    expect(out.next).toHaveLength(1);
    expect("archived" in out).toBe(false);
  });

  it("falls back to verbatim data on a non-object payload, and tolerates a non-object artifact", () => {
    expect(slice_status("not an object")).toBe("not an object");
    const out = slice_status({ active: [null] }) as {
      active: { filename: undefined }[];
    };
    expect(out.active[0].filename).toBeUndefined();
  });
});

describe("slice_store_list", () => {
  it("keeps the store path + each artifact's {filename, kind}; drops ages + counts", () => {
    const out = slice_store_list({
      level: "clean",
      store: "/state/repo",
      active_count: 1,
      archived_count: 1,
      active: [{ filename: "spec-x.md", kind: "spec", ageDays: 3 }],
      archived: [{ filename: "run-old.md", kind: "run", ageDays: 44 }],
    }) as {
      store: string;
      active: Record<string, unknown>[];
      archived: Record<string, unknown>[];
    };
    expect(out.store).toBe("/state/repo");
    expect(out.active[0]).toEqual({ filename: "spec-x.md", kind: "spec" });
    expect(out.archived[0]).toEqual({ filename: "run-old.md", kind: "run" });
    expect("active_count" in out).toBe(false);
  });

  it("falls back on a non-object payload and tolerates a malformed entry", () => {
    expect(slice_store_list(42)).toBe(42);
    const out = slice_store_list({ active: [null], archived: [] }) as {
      active: unknown[];
    };
    expect(out.active).toHaveLength(1);
  });
});

describe("slice_store_lint", () => {
  it("keeps the counts + ONLY the artifacts that carry a diagnostic", () => {
    const out = slice_store_lint({
      level: "warning",
      runCount: 1,
      specCount: 1,
      artifacts: [
        { path: "/store/clean.md", diagnostics: [] },
        {
          path: "/store/bad.md",
          diagnostics: [
            { check: "RUN01", severity: "warning", message: "x", extra: 1 },
          ],
        },
      ],
    }) as { artifacts: { path: string; diagnostics: unknown[] }[] };
    expect(out.artifacts.map((a) => a.path)).toEqual(["/store/bad.md"]); // the clean one is dropped
    expect(out.artifacts[0].diagnostics[0]).toEqual({
      check: "RUN01",
      severity: "warning",
      message: "x",
    });
  });

  it("falls back on a non-object payload and tolerates a malformed artifact/diagnostic", () => {
    expect(slice_store_lint(null)).toBe(null);
    const out = slice_store_lint({
      artifacts: [{ diagnostics: [null] }],
    }) as { artifacts: unknown[] };
    expect(out.artifacts).toHaveLength(1);
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

describe("slice_show_checks", () => {
  it("keeps version + each check {id, severity}; drops the human name", () => {
    const out = slice_show_checks({
      kind: "checks",
      value: {
        version: "0.15.0",
        checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
      },
    }) as { value: { version: string; checks: Record<string, unknown>[] } };
    expect(out.value.version).toBe("0.15.0");
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
