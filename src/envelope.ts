// The result envelope every tool returns. Two invariants live here (both typed + tested):
//   1. `noVerdictIssued: true` — a HARD, tested invariant. corpus-mcp relays the CLI's facts and may
//      DERIVE a triage list, but it never adds a Pass/Fail/approve/merge result of its own.
//   2. `data` is the CLI's `--json` output VERBATIM — including the CLI's own honest fields (a check's
//      `level`/`verdict` outcome, the human-recorded board `reviewStatus`). corpus-mcp passes the human's
//      recorded state through; it does not scrub it and does not adjudicate it.
// The `derived.humanAttention` list is computed BY corpus-mcp from the real ReviewReport facts, labelled
// as derived so no one mistakes it for an engine field (the engine emits facts + an advisory level only).

import { z } from "zod";

import type { CorpusResult } from "./corpus/invoke.ts";
import { ReviewReportSchema, type ReviewReport } from "./corpus/contract.ts";

const NO_VERDICT_NOTE =
  "corpus-mcp surfaces facts only and issues no verdict. A human or an independent reviewer owns the " +
  "review result (Pass / Fail / Unverified / Blocked); an empty or weak Evidence cell reads Unverified " +
  "regardless of a clean reconcile.";

export type Envelope = Readonly<{
  ok: boolean;
  noVerdictIssued: true;
  noVerdictNote: string;
  source: { command: string; exitCode: number };
  data: unknown; // the CLI --json verbatim, or the structured CLI error
  derived?: { humanAttention: string[]; derivedFrom: string };
  note?: string; // adapter-level context (e.g. the run is not launchable here)
}>;

// The output schema (a zod raw shape) advertised on every tool — clients get a typed contract; `data`
// is intentionally loose (it varies per command and is the CLI's own validated shape).
export const ENVELOPE_OUTPUT_SHAPE = {
  ok: z.boolean(),
  noVerdictIssued: z.literal(true),
  noVerdictNote: z.string(),
  source: z.object({ command: z.string(), exitCode: z.number() }),
  data: z.unknown(),
  derived: z
    .object({ humanAttention: z.array(z.string()), derivedFrom: z.string() })
    .optional(),
  note: z.string().optional(),
};

// Compute the triage list from the REAL ReviewReport facts (reconcileReview.ts shape). Every item is a
// fact the engine surfaced — never a verdict.
function derive_human_attention(report: ReviewReport): string[] {
  const items: string[] = [];
  for (const c of report.coverage) {
    items.push(`${c.id}: ${c.message}`);
  }
  for (const v of report.verifyBinding) {
    items.push(v.message); // ReviewReportSchema guarantees `message` is a string (no runtime guard needed)
  }
  for (const s of report.scopeDivergence) {
    items.push(`scope divergence: ${s}`);
  }
  for (const f of report.selfReport.claimedNotInDiff) {
    items.push(`claimed in the run summary but not in the diff: ${f}`);
  }
  for (const f of report.selfReport.inDiffNotClaimed) {
    items.push(`changed in the diff but not claimed: ${f}`);
  }
  if (report.selfReport.runSummaryUnparsed === true) {
    items.push(
      "run summary lists no machine-checkable file paths — selfReport reconcile skipped (list changed files as backticked paths to enable it)",
    );
  }
  for (const f of report.selfReport.outsideScope) {
    items.push(`changed outside the task's affected areas: ${f}`);
  }
  for (const f of report.doNotChangeTouched) {
    items.push(`changed but the task lists it under Do not change: ${f}`);
  }
  for (const r of report.emptyEvidencePassRows) {
    items.push(`${r}: Pass row with empty Evidence — reads Unverified`);
  }
  const ps = report.packetStructural;
  for (const cell of ps.badResultCells) {
    items.push(`invalid Result cell: ${cell}`);
  }
  if (ps.badStatus !== null) {
    items.push(`invalid review status: ${ps.badStatus}`);
  }
  if (ps.statusPassContradicted) {
    items.push(
      "frontmatter says status: pass, but the coverage rows are not all Pass",
    );
  }
  for (const section of ps.missingSections) {
    items.push(`missing required review section: ${section}`);
  }
  return items;
}

// Build an envelope from a successful or structured-error CLI result. `kind: 'review'` additionally
// derives the human-attention list (and surfaces the not-runnable-here case structurally). A
// launch-error never reaches here — `respond()` turns it into a tool error.
export function build_envelope(
  result: Exclude<CorpusResult, { kind: "launch-error" }>,
  kind: "plain" | "review" = "plain",
): Envelope {
  const base = {
    noVerdictIssued: true as const,
    noVerdictNote: NO_VERDICT_NOTE,
    source: result.invocation,
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
  if (kind === "review") {
    const parsed = ReviewReportSchema.safeParse(result.data);
    if (parsed.success) {
      return {
        ...base,
        ok: true,
        data: result.data,
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

  return { ...base, ok: true, data: result.data };
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
      summaryLines.push(`  - ${item}`);
    }
  }
  return {
    content: [{ type: "text", text: summaryLines.join("\n") }],
    structuredContent: envelope as unknown as Record<string, unknown>,
  };
}

// The single dispatch a tool uses: a launch-error (the `corpus` binary is missing / emitted no JSON)
// becomes a tool error; a successful or structured-error result becomes a no-verdict envelope.
export function respond(
  result: CorpusResult,
  kind: "plain" | "review" = "plain",
) {
  if (result.kind === "launch-error") {
    return tool_error(result.message);
  }
  return tool_result(build_envelope(result, kind));
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
