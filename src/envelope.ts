// The minimal result envelope every successful tool dispatch returns.

import { z } from "zod";

import type { SuspecResult } from "./suspec/invoke.ts";

export type Envelope = Readonly<{
  ok: boolean;
  source: { command: string; exitCode: number };
  data: unknown;
  note?: string;
  responseFormat?: "concise" | "detailed"; // which slice `data` carries
}>;

// The output schema (a zod raw shape) advertised on every tool — clients get a typed contract; `data`
// is intentionally loose (it varies per invocation and is the CLI's own validated shape; the real
// typing is the drift-tripwire schemas in contract.ts).
export const ENVELOPE_OUTPUT_SHAPE = {
  // RUNNABILITY, never a result: true = the CLI ran and returned a parseable success payload; false =
  // it returned a structured error. Deliberately NOT tied to the CLI's exit code or diagnostic level —
  // an exit-1/2 check that found problems still ran fine (ok:true) and carries its diagnostics in `data`
  // (`data.level`, diagnostics) + `source.exitCode`. Reading ok:true as "no problems" is a misread.
  ok: z
    .boolean()
    .describe(
      "runnability, not a result: the CLI ran and returned a parseable payload. NOT pass/fail — a " +
        "check that found blocking diagnostics is still ok:true; read data.level / data.diagnostics / " +
        "source.exitCode for the CLI's own recorded facts",
    ),
  source: z
    .object({
      command: z.string(),
      exitCode: z
        .number()
        .describe(
          "the CLI's exit code, relayed verbatim (its contract: 0 clean, 1 warnings, 2 blocking / " +
            "structured error)",
        ),
    })
    .describe("provenance: the exact CLI command run and its exit code"),
  data: z
    .unknown()
    .describe(
      "the CLI --json payload (verbatim in detailed, a slice in concise), or its structured error",
    ),
  note: z.string().optional(),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
};

// Build an envelope from a successful or structured-error CLI result. A launch-error never reaches
// here — `respond()` turns it into a tool error.
//
// `format` selects the slice `data` carries. `slice` (when given) maps the VERBATIM CLI data to a
// smaller, targeted projection in concise mode; detailed mode is always the verbatim payload. The
// slice is applied ONLY to a successful `ok` result — an error data body is small already and
// surfaced whole.
export function build_envelope(
  result: Exclude<SuspecResult, { kind: "launch-error" }>,
  opts: {
    format?: "concise" | "detailed";
    slice?: (data: unknown) => unknown;
  } = {},
): Envelope {
  const format = opts.format;
  const base = {
    source: result.invocation,
    ...(format !== undefined ? { responseFormat: format } : {}),
  };

  if (result.kind === "structured-error") {
    return {
      ...base,
      ok: false,
      data: result.data,
    };
  }

  // result.kind === 'ok'
  // In concise mode, project the verbatim data through the tool's slice (if any); detailed keeps it whole.
  const projected =
    format === "concise" && opts.slice !== undefined
      ? opts.slice(result.data)
      : result.data;
  return { ...base, ok: true, data: projected };
}

// Render the MCP CallToolResult: a short human summary in `content`, the envelope in `structuredContent`.
export function tool_result(envelope: Envelope): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  // The CLI ran for both envelope variants. A structured error means it refused this invocation,
  // not that the binary failed to launch; launch errors never reach this function.
  const summaryLines = [
    `${envelope.source.command} → exit ${String(envelope.source.exitCode)}`,
  ];
  if (envelope.note !== undefined) {
    summaryLines.push(envelope.note);
  }
  const content: { type: "text"; text: string }[] = [
    { type: "text", text: summaryLines.join("\n") },
  ];
  // Text-only clients (opencode today) render `content[].text` and DROP `structuredContent`, so the
  // payload below is invisible there unless we mirror it into a text block. structuredContent-aware
  // clients get the payload
  // twice; universal visibility is the deliberate trade (a tool whose data no mainstream client can see
  // is broken DX regardless of who is spec-correct). Guarded so an empty/absent payload emits nothing.
  if (envelope.data !== undefined && envelope.data !== null) {
    content.push({
      type: "text",
      text: JSON.stringify(envelope.data, null, 2),
    });
  }
  return {
    content,
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

// The single dispatch a tool uses: a launch-error (the `suspec` binary is missing / emitted no JSON)
// becomes a tool error; a successful or structured-error result becomes an envelope. `opts`
// carries the concise/detailed format + the per-tool slice.
export function respond(
  result: SuspecResult,
  opts: {
    format?: "concise" | "detailed";
    slice?: (data: unknown) => unknown;
  } = {},
) {
  if (result.kind === "launch-error") {
    return tool_error(result.message);
  }
  return tool_result(build_envelope(result, opts));
}

// An adapter-level failure (the `suspec` binary is missing / emitted no JSON) or an invalid path is a
// tool error: text + `isError`, with no structuredContent.
export function tool_error(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: `suspec-mcp adapter error: ${message}` }],
    isError: true,
  };
}
