// The result envelope every tool returns. Two invariants live here (both typed + tested):
//   1. `noVerdictIssued: true` — a HARD, tested invariant. suspec-mcp relays the CLI's facts and may
//      DERIVE a triage list, but it never adds a Pass/Fail/approve/merge result of its own.
//   2. `data` is the CLI's `--json` output VERBATIM — including the CLI's own honest fields (a lint's
//      advisory `level`, an evidence row's `status`). suspec-mcp passes the CLI's recorded facts
//      through; it does not scrub them and does not adjudicate them.
// The `derived.humanAttention` list is computed BY suspec-mcp from the real run-review facts, labelled
// as derived so no one mistakes it for an engine field (the engine emits facts + an advisory level only).
// Each item is STRUCTURED `{category, severity, message, ref}` (AC-010) so an agent can act selectively
// without re-parsing `data`.

import { z } from "zod";

import type { SuspecResult } from "./suspec/invoke.ts";
import {
  RunReviewSchema,
  StoreLintSchema,
  type RunReview,
  type StoreLint,
} from "./suspec/contract.ts";

const NO_VERDICT_NOTE =
  "suspec-mcp surfaces facts only and issues no verdict. The human owns the result: `suspec done` is " +
  "the gate, and an AC without fresh, exit-0, cli-verified evidence reads as a gap regardless of a " +
  "clean artifact lint.";

// A structured human-attention item (AC-010). `category` keys the fact CLASS the engine surfaced (so an
// agent can filter to e.g. only evidence gaps); `severity` is advisory triage urgency, NOT a verdict;
// `ref` is the artifact the item is about (an AC id, a store file path) when there is one, else null.
export type AttentionSeverity = "blocking" | "warning" | "info";
export type AttentionCategory = "artifact-lint" | "evidence-gap";
export type AttentionItem = Readonly<{
  category: AttentionCategory;
  severity: AttentionSeverity;
  message: string;
  ref: string | null;
}>;

export type Envelope = Readonly<{
  ok: boolean;
  noVerdictIssued: true;
  noVerdictNote: string;
  source: { command: string; exitCode: number };
  data: unknown; // the CLI --json verbatim (detailed), or a concise slice, or the structured CLI error
  derived?: { humanAttention: AttentionItem[]; derivedFrom: string };
  note?: string; // adapter-level context (e.g. the run does not exist in this repo's store)
  responseFormat?: "concise" | "detailed"; // which slice `data` carries (AC-013)
}>;

// The output schema (a zod raw shape) advertised on every tool — clients get a typed contract; `data`
// is intentionally loose (it varies per command and is the CLI's own validated shape; the real typing is
// the drift-tripwire schemas in contract.ts). The structured humanAttention shape IS pinned here so a
// client can rely on `{category, severity, message, ref}` (AC-010).
const ATTENTION_ITEM_SHAPE = z.object({
  category: z.enum(["artifact-lint", "evidence-gap"]),
  severity: z.enum(["blocking", "warning", "info"]),
  message: z.string(),
  ref: z.string().nullable(),
});

export const ENVELOPE_OUTPUT_SHAPE = {
  // RUNNABILITY, never a result: true = the CLI ran and returned a parseable success payload; false =
  // it returned a structured error. Deliberately NOT tied to the CLI's exit code or diagnostic level —
  // an exit-1/2 lint that found problems still ran fine (ok:true) and carries its findings in `data`
  // (`data.level`, diagnostics) + `source.exitCode`. Reading ok:true as "no problems" is a misread.
  ok: z
    .boolean()
    .describe(
      "runnability, not a result: the CLI ran and returned a parseable payload. NOT pass/fail — a " +
        "lint that found hard errors is still ok:true; read data.level / data diagnostics / " +
        "source.exitCode for the CLI's own recorded facts",
    ),
  noVerdictIssued: z.literal(true),
  noVerdictNote: z.string(),
  source: z
    .object({
      command: z.string(),
      exitCode: z
        .number()
        .describe(
          "the CLI's exit code, relayed verbatim (its unixOutcome contract: 0 clean, 1 warnings, " +
            "2 hard errors / structured error)",
        ),
    })
    .describe("provenance: the exact CLI command run and its exit code"),
  data: z
    .unknown()
    .describe("the CLI --json payload (verbatim in detailed, a slice in concise), or its structured error"),
  derived: z
    .object({
      humanAttention: z.array(ATTENTION_ITEM_SHAPE),
      derivedFrom: z.string(),
    })
    .optional()
    .describe(
      "computed BY suspec-mcp from the CLI facts (labelled so it is never mistaken for an engine " +
        "field): structured triage items, not a verdict",
    ),
  note: z.string().optional(),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
};

// Compute the STRUCTURED triage list from the REAL run-review facts (`suspec review <RUN> --json`,
// review.ts). Every item is a fact the engine surfaced — never a verdict:
//   • each store-lint diagnostic → `artifact-lint`, severity scaled by the diagnostic's own class
//     (hard-error → blocking, warning → warning); ref = the store artifact's path.
//   • each gate gap (an AC short of gate-passing evidence — missing/stale/failing, the wrong Verify
//     command, or an unledgered capture) → `evidence-gap`, warning; ref = the AC id, message built from
//     the matching evidence row's recorded status. This is triage urgency, NOT a Pass/Fail — `suspec
//     done` (the human's gate) owns the result.
// The artifact-lint half, shared by BOTH derivations (a run review's `lint` list and the store lint's
// `artifacts` list carry the same StoreLintArtifact shape): each diagnostic → one `artifact-lint` item,
// severity scaled by the diagnostic's own class (hard-error → blocking, warning → warning).
function derive_lint_attention(
  artifacts: RunReview["lint"] | StoreLint["artifacts"],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const artifact of artifacts) {
    for (const diag of artifact.diagnostics) {
      items.push({
        category: "artifact-lint",
        severity: diag.severity === "hard-error" ? "blocking" : "warning",
        message: `${diag.check}: ${diag.message}`,
        ref: artifact.path,
      });
    }
  }
  return items;
}

function derive_human_attention(report: RunReview): AttentionItem[] {
  const items: AttentionItem[] = derive_lint_attention(report.lint);
  for (const ac of report.gaps) {
    const row = report.evidence.find((r) => r.ac === ac);
    const status = row?.status ?? "missing";
    items.push({
      category: "evidence-gap",
      severity: "warning",
      message: `${ac}: no gate-passing evidence (${status}) — capture the AC's Verify command with \`suspec evidence add ${report.runSlug} --ac ${ac} -- <command>\``,
      ref: ac,
    });
  }
  return items;
}

// Build an envelope from a successful or structured-error CLI result. `kind: 'review'` additionally
// derives the human-attention list (and surfaces the no-such-run case structurally); `kind:
// 'store-lint'` derives the artifact-lint half from the store lint's diagnostics — the SAME AC-010
// category, so a blocking store-lint diagnostic surfaces as structured triage instead of staying
// buried in `data` (the review face and the lint face were asymmetric before, revolver r4). A
// launch-error never reaches here — `respond()` turns it into a tool error.
//
// `format` selects the slice `data` carries (AC-013). `slice` (when given for a read tool) maps the
// VERBATIM CLI data to a smaller, targeted projection in concise mode; detailed mode is always the
// verbatim payload. The slice is applied ONLY to a successful `ok` result — an error data body
// is small already and surfaced whole.
export function build_envelope(
  result: Exclude<SuspecResult, { kind: "launch-error" }>,
  kind: "plain" | "review" | "store-lint" = "plain",
  opts: {
    format?: "concise" | "detailed";
    slice?: (data: unknown) => unknown;
  } = {},
): Envelope {
  const format = opts.format;
  const base = {
    noVerdictIssued: true as const,
    noVerdictNote: NO_VERDICT_NOTE,
    source: result.invocation,
    ...(format !== undefined ? { responseFormat: format } : {}),
  };

  if (result.kind === "structured-error") {
    // A structured CLI error is a FACT for the agent, not an adapter failure. Only the no-run/no-store
    // case gets the "runs appear after `suspec work`" hint — every other cause (usage, lint hard-error,
    // parse failure) must surface its OWN message, never be mislabelled.
    const isNoRun =
      kind === "review" &&
      (result.error.error === "store_run_not_found" ||
        /no store for this repo/i.test(result.error.message));
    return {
      ...base,
      ok: false,
      data: result.error,
      note: isNoRun
        ? "No such run in this repo's store. A run record appears after `suspec work <SPEC>`; list the store runs via suspec_get_status and retry with a run slug."
        : result.error.message,
    };
  }

  // result.kind === 'ok'
  // In concise mode, project the verbatim data through the tool's slice (if any); detailed keeps it whole.
  const projected =
    format === "concise" && opts.slice !== undefined
      ? opts.slice(result.data)
      : result.data;

  if (kind === "review") {
    const parsed = RunReviewSchema.safeParse(result.data);
    if (parsed.success) {
      return {
        ...base,
        ok: true,
        data: projected,
        derived: {
          humanAttention: derive_human_attention(parsed.data),
          derivedFrom: "store run-review facts (`suspec review <RUN>`)",
        },
      };
    }
    // shape drift — surface it rather than silently producing wrong output (the tripwire fires in tests)
    return {
      ...base,
      ok: true,
      data: result.data,
      note: "review output did not match the expected run-review shape — human-attention not derived",
    };
  }

  if (kind === "store-lint") {
    const parsed = StoreLintSchema.safeParse(result.data);
    if (parsed.success) {
      return {
        ...base,
        ok: true,
        data: projected,
        derived: {
          humanAttention: derive_lint_attention(parsed.data.artifacts),
          derivedFrom: "store artifact-lint diagnostics (`suspec check`)",
        },
      };
    }
    // shape drift — same posture as the review path: surface, never silently derive from a bad parse
    return {
      ...base,
      ok: true,
      data: result.data,
      note: "store lint output did not match the expected shape — human-attention not derived",
    };
  }

  return { ...base, ok: true, data: projected };
}

// Render the MCP CallToolResult: a short human summary in `content`, the envelope in `structuredContent`.
export function tool_result(envelope: Envelope): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  const attention = envelope.derived?.humanAttention ?? [];
  // `ran` / `not runnable here` describes RUNNABILITY (did the CLI execute and return parseable JSON),
  // never a review result — deliberately not "ok"/"pass", so a client cannot read the summary as a verdict.
  const summaryLines = [
    `${envelope.source.command} → ${envelope.ok ? "ran" : "not runnable here"} (no verdict issued)`,
  ];
  if (envelope.note !== undefined) {
    summaryLines.push(envelope.note);
  }
  if (attention.length > 0) {
    summaryLines.push(`${attention.length} item(s) need human attention:`);
    for (const item of attention) {
      // The structured item rendered for the text summary: severity + category prefix, then the message.
      summaryLines.push(`  - [${item.severity}/${item.category}] ${item.message}`);
    }
  }
  const content: { type: "text"; text: string }[] = [
    { type: "text", text: summaryLines.join("\n") },
  ];
  // Text-only clients (opencode today) render `content[].text` and DROP `structuredContent`, so the
  // payload below is invisible there unless we mirror it into a text block — the tool otherwise goes
  // silently blind on such a client (suspec-works #88). structuredContent-aware clients get the payload
  // twice; universal visibility is the deliberate trade (a tool whose data no mainstream client can see
  // is broken DX regardless of who is spec-correct). Guarded so an empty/absent payload emits nothing.
  if (envelope.data !== undefined && envelope.data !== null) {
    content.push({ type: "text", text: JSON.stringify(envelope.data, null, 2) });
  }
  return {
    content,
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

// The single dispatch a tool uses: a launch-error (the `suspec` binary is missing / emitted no JSON)
// becomes a tool error; a successful or structured-error result becomes a no-verdict envelope. `kind`
// selects the review-derivation path; `opts` carries the concise/detailed format + the per-tool slice.
export function respond(
  result: SuspecResult,
  kind: "plain" | "review" | "store-lint" = "plain",
  opts: {
    format?: "concise" | "detailed";
    slice?: (data: unknown) => unknown;
  } = {},
) {
  if (result.kind === "launch-error") {
    return tool_error(result.message);
  }
  return tool_result(build_envelope(result, kind, opts));
}

// An adapter-level failure (the `suspec` binary is missing / emitted no JSON) or a rejected request (a
// path outside root) is a tool error: text + `isError`, with NO structuredContent — so it does not have
// to satisfy (and cannot violate) the success outputSchema. An error inherently issues no verdict.
export function tool_error(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: `suspec-mcp adapter error: ${message}` }],
    isError: true,
  };
}
