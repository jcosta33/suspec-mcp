import { describe, it, expect } from "vitest";

import { build_envelope, respond, tool_error } from "../src/envelope.ts";
import type { SuspecResult } from "../src/suspec/invoke.ts";

const okResult = (data: unknown): SuspecResult => ({
  kind: "ok",
  invocation: { command: "suspec check x.md --json", exitCode: 0 },
  data,
});

describe("build_envelope", () => {
  it("uses only the lean public envelope fields", () => {
    const env = build_envelope(okResult({ level: "clean" }));
    expect(Object.keys(env).sort()).toEqual(["data", "ok", "source"]);
  });

  it("passes the CLI data through verbatim (including the CLI's own recorded level)", () => {
    const env = build_envelope(
      okResult({ level: "blocking", diagnostics: [{ code: "C016" }] }),
    );
    expect(env.data).toEqual({
      level: "blocking",
      diagnostics: [{ code: "C016" }],
    });
  });

  it("relays the CLI's exit code verbatim in source (a warnings exit is a fact, not a failure)", () => {
    const env = build_envelope({
      kind: "ok",
      invocation: { command: "suspec check x.md --json", exitCode: 1 },
      data: { level: "warning", diagnostics: [] },
    });
    expect(env.ok).toBe(true);
    expect(env.source.exitCode).toBe(1);
  });

  it("surfaces a structured CLI error as ok:false without repeating its message", () => {
    const env = build_envelope({
      kind: "structured-error",
      invocation: {
        command: "suspec check r.md --spec s.md --json",
        exitCode: 2,
      },
      data: [{
        error: "Usage",
        message:
          "the review names task `TASK-x`: missing --task — usage: suspec check <review-path> --spec <spec-path> --task <task-path>",
      }],
    });
    expect(env.ok).toBe(false);
    expect(env.note).toBeUndefined();
    expect(env.data).toEqual([{
      error: "Usage",
      message:
        "the review names task `TASK-x`: missing --task — usage: suspec check <review-path> --spec <spec-path> --task <task-path>",
    }]);
  });

  it("applies the slice in concise mode only; detailed keeps the verbatim payload", () => {
    const data = { level: "warning", path: "x.md", diagnostics: [] };
    const slice = (d: unknown) => ({
      level: (d as { level: string }).level,
    });
    const concise = build_envelope(okResult(data), {
      format: "concise",
      slice,
    });
    expect(concise.data).toEqual({ level: "warning" });
    expect(concise.responseFormat).toBe("concise");
    const detailed = build_envelope(okResult(data), {
      format: "detailed",
      slice,
    });
    expect(detailed.data).toEqual(data);
    expect(detailed.responseFormat).toBe("detailed");
  });

  it("does NOT slice an error body (surfaced whole, already small)", () => {
    const env = build_envelope(
      {
        kind: "structured-error",
        invocation: { command: "suspec check x.md --json", exitCode: 2 },
        data: [{ error: "Usage", message: "file not found: x.md" }],
      },
      { format: "concise", slice: () => ({ gutted: true }) },
    );
    expect(env.data).toEqual([{
      error: "Usage",
      message: "file not found: x.md",
    }]);
  });
});

describe("respond", () => {
  it("turns a launch-error into a tool error (isError), not an envelope", () => {
    const result = respond({
      kind: "launch-error",
      invocation: { command: "suspec check x.md --json", exitCode: 1 },
      message: "could not launch `suspec`",
    });
    expect("isError" in result && result.isError).toBe(true);
    expect("structuredContent" in result).toBe(false);
  });

  it("turns an ok result into a tool_result carrying the envelope", () => {
    const result = respond(okResult({ level: "clean" }));
    expect("structuredContent" in result).toBe(true);
    if ("structuredContent" in result) {
      expect(result.structuredContent.ok).toBe(true);
    }
  });

  it("mirrors the payload into a text content block for text-only clients", () => {
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

  it("the summary text reports only command provenance and exit status", () => {
    const result = respond({
      kind: "structured-error",
      invocation: { command: "suspec check r.md --json", exitCode: 2 },
      data: [{ error: "Usage", message: "missing --spec" }],
    });
    expect("content" in result).toBe(true);
    if ("content" in result) {
      const summary = result.content[0]?.text ?? "";
      expect(summary).toBe("suspec check r.md --json → exit 2");
    }
  });
});

describe("tool_error", () => {
  it("carries isError and no structuredContent (so it cannot violate the success outputSchema)", () => {
    const e = tool_error("path must be an absolute full path");
    expect(e.isError).toBe(true);
    expect("structuredContent" in e).toBe(false);
    expect(e.content[0].text).toContain("absolute full path");
  });
});
