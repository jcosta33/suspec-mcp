import { describe, it, expect } from "vitest";

import { slice_check_results, slice_contract } from "../src/slices.ts";

// The concise projections are pure shape reducers: they keep report identity + triage fields and
// drop human-readable names. These tests assert (1) the happy-path slice
// drops the right fields and keeps the right ones, AND (2) every defensive fallback arm — a
// malformed/non-object payload returns the verbatim data rather than throwing (concise must never
// become a second failure mode; the contract tripwire owns drift-detection).

describe("slice_check_results", () => {
  it("keeps path, level, and actionable diagnostics including line anchors", () => {
    const out = slice_check_results([
      {
        type: "spec",
        level: "warning",
        path: "specs/a/spec.md",
        diagnostics: [
          { code: "C004", severity: "warning", message: "demo", line: 1 },
        ],
      },
    ]) as { type: string; level: string; path: string; diagnostics: { code: string; line?: number }[] }[];
    expect(out[0].type).toBe("spec");
    expect(out[0].level).toBe("warning");
    expect(out[0].path).toBe("specs/a/spec.md");
    expect(out[0].diagnostics[0]).toEqual({
      code: "C004",
      severity: "warning",
      message: "demo",
      line: 1,
    });
    expect(out[0].diagnostics[0].line).toBe(1);
  });

  it("keeps the unchecked notice whole (checked:false must not read as validated-clean)", () => {
    const out = slice_check_results([
      { level: "clean", path: "audit.md", type: "audit", checked: false },
    ]);
    expect(out).toEqual([
      { level: "clean", path: "audit.md", type: "audit", checked: false },
    ]);
  });

  it("keeps the cross-file report marker", () => {
    const out = slice_check_results([
      { level: "blocking", path: "(file set)", diagnostics: [] },
    ]);
    expect(out).toEqual([
      { level: "blocking", path: "(file set)", diagnostics: [] },
    ]);
  });

  it("falls back on a non-object payload and tolerates a malformed diagnostic", () => {
    expect(slice_check_results(42)).toBe(42);
    expect(slice_check_results([42])).toEqual([42]);
    const out = slice_check_results([{ diagnostics: [null] }]) as {
      diagnostics: unknown[];
    }[];
    expect(out[0].diagnostics).toHaveLength(1);
  });

  it("defaults an absent diagnostics list to [] (the as_array fallback) instead of throwing", () => {
    expect(slice_check_results([{ level: "warning" }])).toEqual([
      { level: "warning", path: undefined, diagnostics: [] },
    ]);
  });

  it("falls back verbatim on an object bearing none of the fields it reads", () => {
    const drifted = { foo: "bar" };
    expect(slice_check_results([drifted])).toEqual([drifted]);
  });
});

describe("slice_contract", () => {
  it("keeps version + each check's {id, severity}; drops the human-readable name", () => {
    const out = slice_contract({
      version: "0.18.0",
      checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
    }) as { version: string; checks: Record<string, unknown>[] };
    expect(out.version).toBe("0.18.0");
    expect(out.checks[0]).toEqual({ id: "C001", severity: "hard-error" });
  });

  it("falls back on a non-object payload and tolerates a malformed check", () => {
    expect(slice_contract(undefined)).toBe(undefined);
    expect(slice_contract("nope")).toBe("nope");
    const out = slice_contract({ version: "0.18.0", checks: [null] }) as {
      checks: unknown[];
    };
    expect(out.checks).toHaveLength(1);
  });

  it("defaults an absent checks list to [] (the as_array fallback) instead of throwing", () => {
    expect(slice_contract({ version: "0.18.0" })).toEqual({
      version: "0.18.0",
      checks: [],
    });
  });

  it("falls back verbatim on an object bearing none of the fields it reads", () => {
    const drifted = { foo: "bar" };
    expect(slice_contract(drifted)).toBe(drifted);
  });
});
