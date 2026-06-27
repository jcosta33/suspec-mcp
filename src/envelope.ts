// The result envelope every tool returns. Two invariants live here (both typed + tested):
//   1. `noVerdictIssued: true` — a HARD, tested invariant. corpus-mcp relays the CLI's facts and may
//      DERIVE a triage list, but it never adds a Pass/Fail/approve/merge result of its own.
//   2. `data` is the CLI's `--json` output VERBATIM — including the CLI's own honest fields (a check's
//      `level`/`verdict` outcome, the human-recorded board `reviewStatus`). corpus-mcp passes the human's
//      recorded state through; it does not scrub it and does not adjudicate it.
// The `derived.humanAttention` list is computed BY corpus-mcp from the real ReviewReport facts, labelled
// as derived so no one mistakes it for an engine field (the engine emits facts + an advisory level only).
// Each item is STRUCTURED `{category, severity, message, ref}` (AC-010) so an agent can act selectively
// without re-parsing `data`.

import { z } from "zod";

import type { CorpusResult } from "./corpus/invoke.ts";
import { ReviewReportSchema, type ReviewReport } from "./corpus/contract.ts";

const NO_VERDICT_NOTE =
  "corpus-mcp surfaces facts only and issues no verdict. A human or an independent reviewer owns the " +
  "review result (Pass / Fail / Unverified / Blocked); an empty or weak Evidence cell reads Unverified " +
  "regardless of a clean reconcile.";

// A structured human-attention item (AC-010). `category` keys the fact CLASS the engine surfaced (so an
// agent can filter to e.g. only coverage gaps); `severity` is advisory triage urgency, NOT a verdict;
// `ref` is the artifact the item is about (an AC id, a file path) when there is one, else null.
export type AttentionSeverity = "blocking" | "warning" | "info";
export type AttentionCategory =
  | "coverage"
  | "verify-binding"
  | "scope-divergence"
  | "self-report"
  | "do-not-change"
  | "empty-evidence"
  | "packet-structural";
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
  note?: string; // adapter-level context (e.g. the run is not launchable here)
  responseFormat?: "concise" | "detailed"; // which slice `data` carries (AC-013)
}>;

// The output schema (a zod raw shape) advertised on every tool — clients get a typed contract; `data`
// is intentionally loose (it varies per command and is the CLI's own validated shape; the real typing is
// the drift-tripwire schemas in contract.ts). The structured humanAttention shape IS pinned here so a
// client can rely on `{category, severity, message, ref}` (AC-010).
const ATTENTION_ITEM_SHAPE = z.object({
  category: z.enum([
    "coverage",
    "verify-binding",
    "scope-divergence",
    "self-report",
    "do-not-change",
    "empty-evidence",
    "packet-structural",
  ]),
  severity: z.enum(["blocking", "warning", "info"]),
  message: z.string(),
  ref: z.string().nullable(),
});

export const ENVELOPE_OUTPUT_SHAPE = {
  ok: z.boolean(),
  noVerdictIssued: z.literal(true),
  noVerdictNote: z.string(),
  source: z.object({ command: z.string(), exitCode: z.number() }),
  data: z.unknown(),
  derived: z
    .object({
      humanAttention: z.array(ATTENTION_ITEM_SHAPE),
      derivedFrom: z.string(),
    })
    .optional(),
  note: z.string().optional(),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
};

// Compute the STRUCTURED triage list from the REAL ReviewReport facts (reconcileReview.ts shape). Every
// item is a fact the engine surfaced — never a verdict. The advisory `severity` follows the engine's own
// `report.level` for the blocking-class facts (coverage/verify/scope/do-not-change/empty-evidence/packet)
// and `info` for the self-report reconcile notes (which are advisory drift signals, never blocking on
// their own). This is triage urgency, NOT a Pass/Fail.
function derive_human_attention(report: ReviewReport): AttentionItem[] {
  const items: AttentionItem[] = [];
  // The engine's advisory level scales the urgency of the blocking-class facts; a `clean`/`warning` run
  // still emits these facts but as `warning`, a `blocking` run as `blocking`. Self-report stays `info`.
  const factSeverity: AttentionSeverity =
    report.level === "blocking" ? "blocking" : "warning";
  const push = (
    category: AttentionCategory,
    severity: AttentionSeverity,
    message: string,
    ref: string | null,
  ): void => {
    items.push({ category, severity, message, ref });
  };

  for (const c of report.coverage) {
    push("coverage", factSeverity, c.message, c.id);
  }
  for (const v of report.verifyBinding) {
    // ReviewReportSchema guarantees `message` is a string (no runtime guard needed).
    push("verify-binding", factSeverity, v.message, v.id);
  }
  for (const s of report.scopeDivergence) {
    push("scope-divergence", factSeverity, `scope divergence: ${s}`, s);
  }
  for (const f of report.selfReport.claimedNotInDiff) {
    push(
      "self-report",
      "info",
      `claimed in the run summary but not in the diff: ${f}`,
      f,
    );
  }
  for (const f of report.selfReport.inDiffNotClaimed) {
    push("self-report", "info", `changed in the diff but not claimed: ${f}`, f);
  }
  if (report.selfReport.runSummaryUnparsed === true) {
    push(
      "self-report",
      "info",
      "run summary lists no machine-checkable file paths — selfReport reconcile skipped (list changed files as backticked paths to enable it)",
      null,
    );
  }
  for (const f of report.selfReport.outsideScope) {
    push(
      "scope-divergence",
      factSeverity,
      `changed outside the task's affected areas: ${f}`,
      f,
    );
  }
  for (const f of report.doNotChangeTouched) {
    push(
      "do-not-change",
      factSeverity,
      `changed but the task lists it under Do not change: ${f}`,
      f,
    );
  }
  for (const r of report.emptyEvidencePassRows) {
    push(
      "empty-evidence",
      factSeverity,
      `${r}: Pass row with empty Evidence — reads Unverified`,
      r,
    );
  }
  const ps = report.packetStructural;
  for (const cell of ps.badResultCells) {
    push("packet-structural", factSeverity, `invalid Result cell: ${cell}`, cell);
  }
  if (ps.badStatus !== null) {
    push(
      "packet-structural",
      factSeverity,
      `invalid review status: ${ps.badStatus}`,
      ps.badStatus,
    );
  }
  if (ps.statusPassContradicted) {
    push(
      "packet-structural",
      factSeverity,
      "frontmatter says status: pass, but the coverage rows are not all Pass",
      null,
    );
  }
  for (const section of ps.missingSections) {
    push(
      "packet-structural",
      factSeverity,
      `missing required review section: ${section}`,
      section,
    );
  }
  return items;
}

// Build an envelope from a successful or structured-error CLI result. `kind: 'review'` additionally
// derives the human-attention list (and surfaces the not-runnable-here case structurally). A
// launch-error never reaches here — `respond()` turns it into a tool error.
//
// `format` selects the slice `data` carries (AC-013). `slice` (when given for a read tool) maps the
// VERBATIM CLI data to a smaller, targeted projection in concise mode (≈⅓ the tokens); detailed mode is
// always the verbatim payload. The slice is applied ONLY to a successful `ok` result — an error data body
// is small already and surfaced whole.
export function build_envelope(
  result: Exclude<CorpusResult, { kind: "launch-error" }>,
  kind: "plain" | "review" = "plain",
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
    // A structured CLI error is a FACT for the agent, not an adapter failure. Only the no-worktree
    // case gets the "launch the run first" hint — every other cause (task not found, source spec
    // unresolvable, parse failure, diff failure) must surface its OWN message, never be mislabelled.
    const isNoWorktree =
      kind === "review" && /no worktree/i.test(result.error.message);
    return {
      ...base,
      ok: false,
      data: result.error,
      note: isNoWorktree
        ? "The task has no live run to reconcile here (no worktree). Launch the run first, then retry."
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
    const parsed = ReviewReportSchema.safeParse(result.data);
    if (parsed.success) {
      return {
        ...base,
        ok: true,
        data: projected,
        derived: {
          humanAttention: derive_human_attention(parsed.data),
          derivedFrom: "ReviewReport facts",
        },
      };
    }
    // shape drift — surface it rather than silently producing wrong output (the tripwire fires in tests)
    return {
      ...base,
      ok: true,
      data: result.data,
      note: "reconcile output did not match the expected ReviewReport shape — human-attention not derived",
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
  return {
    content: [{ type: "text", text: summaryLines.join("\n") }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

// The single dispatch a tool uses: a launch-error (the `corpus` binary is missing / emitted no JSON)
// becomes a tool error; a successful or structured-error result becomes a no-verdict envelope. `kind`
// selects the review-derivation path; `opts` carries the concise/detailed format + the per-tool slice.
export function respond(
  result: CorpusResult,
  kind: "plain" | "review" = "plain",
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

// An adapter-level failure (the `corpus` binary is missing / emitted no JSON) or a rejected request (a
// path outside root) is a tool error: text + `isError`, with NO structuredContent — so it does not have
// to satisfy (and cannot violate) the success outputSchema. An error inherently issues no verdict.
export function tool_error(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [{ type: "text", text: `corpus-mcp adapter error: ${message}` }],
    isError: true,
  };
}
