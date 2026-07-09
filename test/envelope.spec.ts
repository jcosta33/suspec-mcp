import { describe, it, expect } from "vitest";

import { build_envelope, respond, tool_error } from "../src/envelope.ts";
import type { SuspecResult } from "../src/suspec/invoke.ts";

// A CONTROLLED run review for the derive-logic test (deterministic, independent of any captured
// fixture — the captured-output drift tripwire lives in contract.spec.ts).
const reviewData = {
  level: "warning",
  runSlug: "demo",
  specId: "SPEC-demo",
  lint: [
    { path: "/store/run-demo.md", diagnostics: [] },
    {
      path: "/store/spec-demo.md",
      diagnostics: [
        {
          check: "C004",
          severity: "warning",
          message: "requirement AC-001 uses two strength words",
        },
      ],
    },
  ],
  evidence: [
    {
      ac: "AC-001",
      command: "pnpm test",
      exit: 0,
      evidenceRef: "001-pnpm-test.md",
      provenance: "cli-verified",
      status: "verified",
    },
    {
      ac: "AC-002",
      command: "`second test`",
      exit: null,
      evidenceRef: null,
      provenance: null,
      status: "missing",
    },
  ],
  gaps: ["AC-002"],
};

const okResult = (data: unknown): SuspecResult => ({
  kind: "ok",
  invocation: { command: "suspec x --json", exitCode: 0 },
  data,
});

describe("build_envelope", () => {
  it("always sets noVerdictIssued:true and carries no verdict field of its own", () => {
    const env = build_envelope(okResult({ level: "clean" }));
    expect(env.noVerdictIssued).toBe(true);
    // suspec-mcp's OWN keys never include a verdict/approval
    for (const key of [
      "verdict",
      "pass",
      "fail",
      "merge",
      "decision",
      "approved",
    ]) {
      expect(Object.keys(env)).not.toContain(key);
    }
  });

  it("passes the CLI data through verbatim (including the CLI's own advisory level)", () => {
    const env = build_envelope(okResult({ level: "blocking", gaps: ["AC-001"] }));
    expect(env.data).toEqual({ level: "blocking", gaps: ["AC-001"] });
  });

  it("derives a STRUCTURED human-attention list {category,severity,message,ref} from the run-review facts (AC-010)", () => {
    const env = build_envelope(okResult(reviewData), "review");
    const attention = env.derived?.humanAttention ?? [];
    expect(env.derived?.derivedFrom).toMatch(/run-review facts/);
    // Each item is a structured object, not a flat string (AC-010): an agent can filter on category/ref
    // without re-parsing `data`.
    const gap = attention.find((a) => a.ref === "AC-002");
    expect(gap).toBeDefined();
    expect(gap?.category).toBe("evidence-gap");
    expect(gap?.severity).toBe("warning");
    // the message carries the row's recorded status + the capture command to close the gap
    expect(gap?.message).toContain("missing");
    expect(gap?.message).toContain("suspec evidence add demo --ac AC-002");
    // the lint diagnostic surfaces by artifact path with its check code
    const lint = attention.find((a) => a.category === "artifact-lint");
    expect(lint?.ref).toBe("/store/spec-demo.md");
    expect(lint?.message).toContain("C004");
    expect(lint?.severity).toBe("warning");
    // the verified AC-001 row derives NO attention item (nothing to route)
    expect(attention.some((a) => a.ref === "AC-001")).toBe(false);
  });

  it("a hard-error lint diagnostic derives a BLOCKING item; a gap without a matching row reads missing", () => {
    const blocking = {
      ...reviewData,
      level: "blocking",
      lint: [
        {
          path: "/store/evidence/demo/001.md",
          diagnostics: [
            {
              check: "EV01",
              severity: "hard-error",
              message: "claims cli-verified but has no capture block",
            },
          ],
        },
      ],
      evidence: [],
      gaps: ["AC-009"], // no evidence row carries AC-009 — the fallback message arm
    };
    const att =
      build_envelope(okResult(blocking), "review").derived?.humanAttention ?? [];
    const lint = att.find((a) => a.category === "artifact-lint");
    expect(lint?.severity).toBe("blocking");
    expect(lint?.message).toContain("EV01");
    const gap = att.find((a) => a.ref === "AC-009");
    expect(gap?.message).toContain("missing");
    // Every item carries the structured quadruple — never a bare string (AC-010).
    for (const item of att) {
      expect(["artifact-lint", "evidence-gap"]).toContain(item.category);
      expect(["blocking", "warning", "info"]).toContain(item.severity);
      expect(typeof item.message).toBe("string");
      expect(item.ref === null || typeof item.ref === "string").toBe(true);
    }
  });

  it("a store-lint result derives the SAME structured artifact-lint items as a review's lint half", () => {
    const lintData = {
      level: "blocking",
      runCount: 1,
      specCount: 1,
      artifacts: [
        { path: "/store/run-demo.md", diagnostics: [] },
        {
          path: "/store/spec-demo.md",
          diagnostics: [
            { check: "C007", severity: "hard-error", message: "spec has {{TBD}} placeholders" },
            { check: "C004", severity: "warning", message: "two strength words" },
          ],
        },
      ],
    };
    const env = build_envelope(okResult(lintData), "store-lint");
    const att = env.derived?.humanAttention ?? [];
    expect(env.derived?.derivedFrom).toContain("suspec check");
    expect(att).toHaveLength(2);
    expect(att[0]).toEqual({
      category: "artifact-lint",
      severity: "blocking",
      message: "C007: spec has {{TBD}} placeholders",
      ref: "/store/spec-demo.md",
    });
    expect(att[1]?.severity).toBe("warning");
  });

  it("surfaces store-lint shape drift with a note instead of deriving from a bad parse", () => {
    const env = build_envelope(okResult({ level: "clean" /* artifacts dropped */ }), "store-lint");
    expect(env.ok).toBe(true);
    expect(env.derived).toBeUndefined();
    expect(env.note).toMatch(/store lint output did not match/);
  });

  it("surfaces a structured CLI no-such-run error as ok:false with the runs-appear-after-work hint", () => {
    const env = build_envelope(
      {
        kind: "structured-error",
        invocation: { command: "suspec review x --json", exitCode: 2 },
        error: {
          error: "store_run_not_found",
          message: "no run x in the store (searched /store/run-x.md)",
        },
      },
      "review",
    );
    expect(env.ok).toBe(false);
    expect(env.noVerdictIssued).toBe(true);
    expect(env.note).toMatch(/no such run/i);
    expect(env.note).toMatch(/suspec work/);
    expect(env.data).toEqual({
      error: "store_run_not_found",
      message: "no run x in the store (searched /store/run-x.md)",
    });
  });

  it("gives the same hint for the no-store-yet review error (runs cannot exist without a store)", () => {
    const env = build_envelope(
      {
        kind: "structured-error",
        invocation: { command: "suspec review x --json", exitCode: 2 },
        error: {
          error: "Usage",
          message:
            "no store for this repo yet — nothing to review (a run appears after `suspec work`)",
        },
      },
      "review",
    );
    expect(env.ok).toBe(false);
    expect(env.note).toMatch(/no such run/i);
  });

  it("does NOT mislabel a different review error as the no-run case", () => {
    const env = build_envelope(
      {
        kind: "structured-error",
        invocation: { command: "suspec review x --json", exitCode: 2 },
        error: {
          error: "Usage",
          message: 'invalid run ref "a/b": expected a run slug, not a path',
        },
      },
      "review",
    );
    expect(env.ok).toBe(false);
    expect(env.note).toBe('invalid run ref "a/b": expected a run slug, not a path'); // the real message, not the hint
  });

  it("a non-review structured error surfaces its own message verbatim", () => {
    const env = build_envelope({
      kind: "structured-error",
      invocation: { command: "suspec status --json", exitCode: 2 },
      error: { error: "Usage", message: "something else entirely" },
    });
    expect(env.ok).toBe(false);
    expect(env.note).toBe("something else entirely");
  });

  it("surfaces shape drift (the tripwire) when a review result does not match RunReviewSchema", () => {
    // If the CLI's review shape ever drifts, suspec-mcp must NOT silently derive a wrong attention
    // list — it passes the data through and notes that human-attention could not be derived.
    const env = build_envelope(
      okResult({ totally: "not a run review" }),
      "review",
    );
    expect(env.ok).toBe(true);
    expect(env.derived).toBeUndefined();
    expect(env.note).toMatch(/did not match the expected run-review shape/i);
    expect(env.data).toEqual({ totally: "not a run review" }); // still passed through verbatim
  });
});

describe("respond", () => {
  it("turns a launch-error into a tool error (isError), not an envelope", () => {
    const result = respond({
      kind: "launch-error",
      invocation: { command: "suspec status --json", exitCode: 1 },
      message: "could not launch `suspec`",
    });
    expect("isError" in result && result.isError).toBe(true);
    expect("structuredContent" in result).toBe(false);
  });

  it("turns an ok result into a tool_result carrying the envelope", () => {
    const result = respond(okResult({ level: "clean" }));
    expect("structuredContent" in result).toBe(true);
    if ("structuredContent" in result) {
      expect(result.structuredContent.noVerdictIssued).toBe(true);
    }
  });

  it("mirrors the payload into a text content block for text-only clients (suspec-works #88)", () => {
    // opencode renders only content[].text and drops structuredContent — the payload must survive there.
    const result = respond(okResult({ level: "clean" }));
    expect("content" in result).toBe(true);
    if ("content" in result) {
      // content[0] is the runnability summary; content[1] is the JSON payload mirror.
      expect(result.content.length).toBe(2);
      const mirrored = result.content[1]?.text ?? "";
      expect(mirrored).toContain('"level": "clean"');
      // The same data lives in structuredContent — text-only and structured clients agree.
      if ("structuredContent" in result) {
        expect(JSON.parse(mirrored)).toEqual(result.structuredContent.data);
      }
    }
  });

  it("the review summary text renders the derived attention items with severity/category prefixes", () => {
    const result = respond(okResult(reviewData), "review");
    expect("content" in result).toBe(true);
    if ("content" in result) {
      const summary = result.content[0]?.text ?? "";
      expect(summary).toContain("need human attention");
      expect(summary).toContain("[warning/evidence-gap]");
      expect(summary).toMatch(/no verdict issued/);
    }
  });
});

describe("tool_error", () => {
  it("carries isError and no structuredContent (so it cannot violate the success outputSchema)", () => {
    const e = tool_error("refusing a path outside the workspace root");
    expect(e.isError).toBe(true);
    expect("structuredContent" in e).toBe(false);
    expect(e.content[0].text).toContain("refusing a path");
  });
});
