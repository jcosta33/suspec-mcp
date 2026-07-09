// The v2 prompts — short, procedural templates that shape the agent toward calling the tools, never
// duplicating their logic. The before-done / review-assistant pair is deliberately ASYMMETRIC: it is
// the honesty lever for the "does arming the implementer with reconcile launder the gate?" tension —
// the implementer gets the facts to close mechanical gaps but is told it cannot close the gate; the
// reviewer is told a clean reconcile is a starting point to falsify, not a result to trust. No prompt
// grants any verdict authority (ADR-0077 D8 — reconcile-only, verdict-free, upheld by ADR-0137).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function user_text(text: string): {
  messages: { role: "user"; content: { type: "text"; text: string } }[];
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function register_prompts(server: McpServer): void {
  server.registerPrompt(
    "suspec_before_done",
    {
      title: "Implementer self-check before claiming ready",
      description:
        "The implementer-facing pre-handoff check: close the mechanical gaps you can see — but you cannot close the gate.",
      argsSchema: { run: z.string() },
    },
    ({ run }) =>
      user_text(
        `Before you claim run ${run} is ready:\n\n` +
          `1. Call suspec_reconcile (run: ${run}) — it previews exactly what \`suspec done\` will gate on: ` +
          `the artifact lint plus every spec AC's evidence row (verified / stale / failing / missing).\n` +
          `2. Fix every lint diagnostic you can (the run record, the spec, the evidence records).\n` +
          `3. For every evidence gap, capture real proof: \`suspec evidence add ${run} --ac <AC> -- <command>\` ` +
          `runs the command in the run worktree and records it cli-verified. Never hand-write an evidence record.\n` +
          `4. Re-run suspec_reconcile until the gaps you can close are closed; report the ones you cannot.\n\n` +
          `You MAY say the run is "ready."\n` +
          `You may NOT close the gate. \`suspec done\` is the human's; an AC without fresh, exit-0, ` +
          `cli-verified evidence reads Unverified — a gap — regardless of a clean lint. Do not issue a ` +
          `result on your own work.`,
      ),
  );

  server.registerPrompt(
    "suspec_review_assistant",
    {
      title: "Independent reviewer assistant (refute-by-default)",
      description:
        "Help an INDEPENDENT reviewer: re-derive the facts, treat a clean reconcile as something to falsify, not trust.",
      argsSchema: { run: z.string() },
    },
    ({ run }) =>
      user_text(
        `You are reviewing run ${run}, which you did NOT author.\n\n` +
          `Call suspec_reconcile (run: ${run}) and RE-DERIVE the facts yourself: read the evidence rows ` +
          `against the spec's ACs, and load the store spec + run record yourself — ` +
          `suspec_get_artifact (kind: spec|run, ref: <id or slug>); suspec_get_status lists the ` +
          `filenames. A clean reconcile from the implementer is a ` +
          `starting point to falsify, not a result to trust — the implementer may have pre-closed the ` +
          `mechanical gaps; verify, do not assume.\n\n` +
          `Every AC needs fresh, exit-0, cli-verified evidence; anything else reads Unverified. Route ` +
          `exceptions to human attention. Do not edit source code. Do not approve an implementation you ` +
          `authored, and do not close the gate — \`suspec done\` is the human's.`,
      ),
  );

  server.registerPrompt(
    "suspec_evidence_rule",
    {
      title: "The evidence rule",
      description:
        "A claim is not evidence; an AC without fresh cli-verified evidence is a gap, never done.",
    },
    () =>
      user_text(
        `A claim is not evidence.\n\n` +
          `An AC counts as evidenced only by a fresh, exit-0, cli-verified evidence record — one captured ` +
          `by \`suspec evidence add <RUN> --ac <AC> -- <command>\`, which runs the command itself and ` +
          `records the output. A hand-written record is forged (the lint flags it); a stale record ` +
          `(the worktree changed since capture) does not count; an agent's own assertion never counts.\n\n` +
          `suspec-mcp surfaces facts; it issues no verdict. \`suspec done\` — the human's gate — decides.`,
      ),
  );
}
