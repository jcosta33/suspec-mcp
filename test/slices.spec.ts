import { describe, it, expect } from "vitest";

import { slice_check_file, slice_contract } from "../src/slices.ts";

// The concise projections are pure shape reducers: they keep the identifiers + triage fields and drop
// the echoes (path, line anchors, human-readable names). These tests assert (1) the happy-path slice
// drops the right fields and keeps the right ones, AND (2) every defensive fallback arm — a
// malformed/non-object payload returns the verbatim data rather than throwing (concise must never
// become a second failure mode; the contract tripwire owns drift-detection).

describe("slice_check_file", () => {
  it("keeps level + the diagnostic triple; drops the path echo + line anchors", () => {
    const out = slice_check_file({
      level: "warning",
      path: "specs/a/spec.md",
      diagnostics: [
        { code: "C004", severity: "warning", message: "demo", line: 1 },
      ],
    }) as { level: string; diagnostics: { code: string; line?: number }[] };
    expect(out.level).toBe("warning");
    expect(out.diagnostics[0]).toEqual({
      code: "C004",
      severity: "warning",
      message: "demo",
    });
    expect("line" in out.diagnostics[0]).toBe(false);
    expect("path" in out).toBe(false);
  });

  it("keeps the unchecked notice whole (checked:false must not read as validated-clean)", () => {
    const out = slice_check_file({
      level: "clean",
      path: "task.md",
      type: "task",
      checked: false,
    });
    expect(out).toEqual({ level: "clean", type: "task", checked: false });
  });

  it("falls back on a non-object payload and tolerates a malformed diagnostic", () => {
    expect(slice_check_file(42)).toBe(42);
    const out = slice_check_file({ diagnostics: [null] }) as {
      diagnostics: unknown[];
    };
    expect(out.diagnostics).toHaveLength(1);
  });
});

describe("slice_contract", () => {
  it("keeps version + each check's {id, severity}; drops the human-readable name", () => {
    const out = slice_contract({
      version: "0.16.0",
      checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
    }) as { version: string; checks: Record<string, unknown>[] };
    expect(out.version).toBe("0.16.0");
    expect(out.checks[0]).toEqual({ id: "C001", severity: "hard-error" });
  });

  it("falls back on a non-object payload and tolerates a malformed check", () => {
    expect(slice_contract(undefined)).toBe(undefined);
    expect(slice_contract("nope")).toBe("nope");
    const out = slice_contract({ version: "0.16.0", checks: [null] }) as {
      checks: unknown[];
    };
    expect(out.checks).toHaveLength(1);
  });
});
