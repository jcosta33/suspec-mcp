// The v0 prompts — short, procedural templates that shape the agent toward calling the tools, never
// duplicating their logic. The before-done / review-assistant pair is deliberately ASYMMETRIC: it is
// the honesty lever for the "does arming the implementer with reconcile launder the gate?" tension —
// the implementer gets the facts to clean mechanical drift but is told it cannot sign off; the reviewer
// is told a clean reconcile is a starting point to falsify, not a result to trust. No prompt grants any
// verdict authority (ADR-0077 D8).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function user_text(text: string): {
  messages: { role: "user"; content: { type: "text"; text: string } }[];
} {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

export function register_prompts(server: McpServer): void {
  server.registerPrompt(
    "corpus_task_briefing",
    {
      title: "Brief an agent on a Corpus task",
      description:
        "Prepare to work on a task: read its scope, do-not-change list, verify items, and open questions first.",
      argsSchema: { task: z.string() },
    },
    ({ task }) =>
      user_text(
        `You are about to work on Corpus task ${task}.\n\n` +
          `First call:\n` +
          `- corpus_get_task (its scope, affected areas, verify items)\n` +
          `- corpus_get_spec for every linked spec\n` +
          `- corpus_get_checks (what review will hold the work to)\n\n` +
          `Then summarize the scope, the do-not-change list, the verify items, and any open questions.\n` +
          `Do not edit code until the scope is confirmed. Do not implement behavior outside scope. If the ` +
          `task is unclear, ask before proceeding.`,
      ),
  );

  server.registerPrompt(
    "corpus_before_done",
    {
      title: "Implementer self-check before claiming ready",
      description:
        "The implementer-facing pre-handoff check: clean the mechanical drift you can see — but you cannot sign off.",
      argsSchema: { task: z.string() },
    },
    ({ task }) =>
      user_text(
        `Before you claim ${task} is ready for review:\n\n` +
          `1. Call corpus_scan_task (reconcile against the diff).\n` +
          `2. Call corpus_reconcile_review, and corpus_validate_review_packet if a review packet exists.\n` +
          `3. Fix or report every coverage gap, out-of-scope change, and empty-evidence Pass row it surfaces.\n` +
          `4. Leave a run summary: changed files, the verify output, out-of-scope edits, candidate findings.\n\n` +
          `You MAY say the work is "ready for review."\n` +
          `You may NOT approve it. An independent reviewer owns the result — and a clean reconcile does not make ` +
          `it Pass: an empty or weak Evidence cell reads Unverified regardless. Do not issue a result on your own work.`,
      ),
  );

  server.registerPrompt(
    "corpus_review_assistant",
    {
      title: "Independent reviewer assistant (refute-by-default)",
      description:
        "Help an INDEPENDENT reviewer: re-derive the facts, treat a clean reconcile as something to falsify, not trust.",
      argsSchema: { task: z.string() },
    },
    ({ task }) =>
      user_text(
        `You are reviewing work on ${task} that you did NOT author.\n\n` +
          `Call corpus_get_task, corpus_get_spec, corpus_scan_task, and corpus_reconcile_review and RE-DERIVE the ` +
          `facts yourself. A clean reconcile from the implementer is a starting point to falsify, not a result ` +
          `to trust — the implementer may have pre-fixed the mechanical drift; verify, do not assume.\n\n` +
          `Every Pass row must cite evidence; an empty Evidence cell is Unverified. Route exceptions to Human ` +
          `attention. Do not edit source code. Do not approve an implementation you authored.`,
      ),
  );

  server.registerPrompt(
    "corpus_evidence_rule",
    {
      title: "The evidence rule",
      description:
        "A claim is not evidence; an empty Evidence cell is Unverified, never Pass.",
    },
    () =>
      user_text(
        `A claim is not evidence.\n\n` +
          `A Pass row requires one of: pasted command output, a CI link, or a named human's recorded ` +
          `observation (for a manual check). An empty Evidence cell is Unverified, never Pass.\n\n` +
          `corpus-mcp surfaces facts; it issues no verdict. The human or the independent reviewer decides.`,
      ),
  );

  server.registerPrompt(
    "corpus_finding_candidate",
    {
      title: "Draft a candidate finding",
      description:
        "Scaffold a durable finding from a discovered fact — as a candidate, never accepted.",
    },
    () =>
      user_text(
        `Draft a candidate finding from the durable fact you discovered:\n\n` +
          `- one claim\n- the evidence for it\n- where it applies\n- where it does NOT apply\n- the future guidance\n\n` +
          `Set status to "candidate", never "accepted" — acceptance is the owner's. If the fact implies required ` +
          `behavior, note that a spec amendment is owed.`,
      ),
  );
}
