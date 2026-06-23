// The v0 read/reconcile tools — each a thin map onto a `corpus <cmd> --json` invocation. Slice 1 covers
// the tools that ride EXISTING CLI --json (status, check, review); the loader tools (get_task/spec/…)
// land in slice 3 on the new `corpus show` family. Every tool is read-only and routes through the
// no-verdict envelope.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type CorpusEnv, invoke_corpus } from "./corpus/invoke.ts";
import {
  confine_path,
  is_safe_segment,
  is_safe_base,
  task_stem,
} from "./roots.ts";
import { respond, tool_error, ENVELOPE_OUTPUT_SHAPE } from "./envelope.ts";

export type Ctx = Readonly<{ env: CorpusEnv; root: string }>;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function register_tools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    "corpus_get_status",
    {
      title: "Corpus workspace board",
      description:
        "The derived workspace board — specs, their tasks, and review status. Read-only; no verdict.",
      inputSchema: {},
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    () => respond(invoke_corpus(ctx.env, "status")),
  );

  server.registerTool(
    "corpus_check_workspace",
    {
      title: "Check the whole workspace",
      description:
        "Run the Corpus checks contract over every spec + change plan. Returns diagnostics, never a verdict.",
      inputSchema: {},
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    () => respond(invoke_corpus(ctx.env, "check")),
  );

  server.registerTool(
    "corpus_check_file",
    {
      title: "Check one artifact file",
      description:
        "Run the Corpus checks contract over one file (spec, review, or change-plan) via `corpus check`. " +
        "A task packet is NOT supported — `corpus check` lints it as a spec and emits spurious warnings. " +
        "Returns diagnostics, never a verdict.",
      inputSchema: {
        path: z
          .string()
          .describe("workspace-relative path to the artifact file"),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ path }) => {
      const safe = confine_path(ctx.root, path);
      if (safe === null) {
        return tool_error(
          `refusing a path outside the workspace root: ${path}`,
        );
      }
      return respond(invoke_corpus(ctx.env, "check", [safe]));
    },
  );

  // scan_task and reconcile_review are the SAME engine (`corpus review`): there is one reconcile, no
  // separate scan. scan = reconcile with no review packet present (the report carries hasReviewPacket).
  const review_tool = (
    name: string,
    title: string,
    description: string,
  ): void => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          task: z
            .string()
            .describe("task id or stem (the CLI reviews `tasks/<stem>.md`)"),
          base: z
            .string()
            .optional()
            .describe("the base branch/commit to diff the worktree against"),
        },
        outputSchema: ENVELOPE_OUTPUT_SHAPE,
        annotations: READ_ONLY,
      },
      ({ task, base }) => {
        const stem = task_stem(task);
        if (!is_safe_segment(stem)) {
          return tool_error(`invalid task id/stem: ${task}`);
        }
        // A base ref legitimately contains `/`/`~` (origin/main, HEAD~1) — validate it as a base,
        // and REJECT an invalid one rather than silently dropping it (which would diff against the
        // wrong base with no error the agent could detect).
        if (typeof base === "string" && !is_safe_base(base)) {
          return tool_error(`invalid --base value: ${base}`);
        }
        const baseArg = typeof base === "string" ? base : undefined;
        return respond(
          invoke_corpus(ctx.env, "review", [stem], { base: baseArg }),
          "review",
        );
      },
    );
  };

  review_tool(
    "corpus_scan_task",
    "Scan a task in progress (reconcile vs the diff)",
    "Reconcile a task against its spec and the worktree diff to surface coverage gaps, out-of-scope changes, and " +
      "self-report mismatches — before a review packet exists. Same engine as reconcile_review. Never a verdict. " +
      'If the task has no live worktree, returns a structured "not runnable here" result, not an error.',
  );
  review_tool(
    "corpus_reconcile_review",
    "Reconcile a review packet vs task/spec/diff",
    "Reconcile a finished run: compare task, spec, review packet, and git diff. Returns coverage gaps, empty-evidence " +
      "Pass rows, scope drift, and self-report mismatches as facts + a derived human-attention list. Never issues a " +
      "final verdict — a human or an independent reviewer owns the result.",
  );

  server.registerTool(
    "corpus_validate_review_packet",
    {
      title: "Validate a review packet (structure + evidence)",
      description:
        "Run the review-file checks (C012 coverage, C013 verify-evidence binding) over a review packet via " +
        "`corpus check`. Surfaces ONLY those two checks — the structural facts (an invalid status, missing " +
        "sections, a Pass row with empty evidence) and the diff-aware facts (out-of-scope, self-report) are " +
        "NOT run by this check; they come from reconcile_review when a worktree exists. So a clean result " +
        "here is not a full packet validation. Returns diagnostics, never a verdict.",
      inputSchema: {
        review: z
          .string()
          .describe("workspace-relative path to the review packet file"),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ review }) => {
      const safe = confine_path(ctx.root, review);
      if (safe === null) {
        return tool_error(
          `refusing a path outside the workspace root: ${review}`,
        );
      }
      return respond(invoke_corpus(ctx.env, "check", [safe]));
    },
  );

  // --- loader tools (the parsed-artifact projections, on `corpus show … --json`) -----------------
  server.registerTool(
    "corpus_get_task",
    {
      title: "Get a parsed task packet",
      description:
        "The task packet`s scope, affected areas, claimed changes, and frontmatter (id/source/status). Read-only.",
      inputSchema: { task: z.string().describe("task id or stem") },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ task }) => {
      // Pass the id/slug through unchanged: `corpus show task` resolves either `pastebin` or
      // `TASK-pastebin` to the canonical tasks/TASK-<slug>.md, so pre-stripping the prefix (which
      // mismatched the file `corpus new task` writes) is both unnecessary and wrong.
      if (!is_safe_segment(task)) {
        return tool_error(`invalid task id/stem: ${task}`);
      }
      return respond(invoke_corpus(ctx.env, "show", ["task", task]));
    },
  );

  server.registerTool(
    "corpus_get_spec",
    {
      title: "Get a parsed spec",
      description:
        "The spec`s frontmatter, requirements (id + line + named verify command), and sections. Read-only.",
      inputSchema: { spec: z.string().describe("spec id (e.g. SPEC-auth)") },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ spec }) => {
      if (!is_safe_segment(spec)) {
        return tool_error(`invalid spec id: ${spec}`);
      }
      return respond(invoke_corpus(ctx.env, "show", ["spec", spec]));
    },
  );

  server.registerTool(
    "corpus_get_review",
    {
      title: "Get a parsed review packet",
      description:
        "The review packet`s status, coverage rows, and verify blocks. Read-only; the verdict is the human`s.",
      inputSchema: {
        task: z
          .string()
          .describe("task id or stem (the review is reviews/<stem>.md)"),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ task }) => {
      const stem = task_stem(task);
      if (!is_safe_segment(stem)) {
        return tool_error(`invalid task id/stem: ${task}`);
      }
      return respond(invoke_corpus(ctx.env, "show", ["review", stem]));
    },
  );

  server.registerTool(
    "corpus_get_checks",
    {
      title: "Get the checks contract",
      description:
        "The checks contract — version + the core checks (id/name/severity). What review must satisfy.",
      inputSchema: {},
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    () => respond(invoke_corpus(ctx.env, "show", ["checks"])),
  );
}
