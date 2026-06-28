// The Corpus MCP tool surface. Three tiers, all routed through the no-verdict envelope:
//   • READ — status / list / check / show-loader projections over the CLI's read `--json` (status, check,
//     show). Each declares an outputSchema and takes a `response_format` (concise|detailed, AC-013):
//     concise returns the relevant slice (≈⅓ the tokens), detailed the verbatim payload.
//   • RECONCILE — the single `corpus_reconcile` (AC-007): one engine (`corpus review`), one tool. The
//     scan-vs-reconcile distinction is data-driven (`report.hasReviewPacket`), not two tools; the
//     implementer-vs-reviewer STANCE split lives in the prompts (prompts.ts), not here.
//   • SAFE-WRITE — the verdict-free prepare tier (AC-009 / ADR-0077 D8): scaffold_spec / split_task /
//     scaffold_finding back the CLI's `new spec` / `new task --from` / `promote`. Each SCAFFOLDS a fresh
//     artifact and writes NO board, NO review result, and issues NO verdict — it is annotated non-verdict
//     and read-adjacent (it creates an artifact; it never adjudicates one).

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
import {
  slice_status,
  slice_file_check,
  slice_workspace_check,
  slice_show_task,
  slice_show_spec,
  slice_show_review,
  slice_show_checks,
  list_from_board,
} from "./slices.ts";

export type Ctx = Readonly<{ env: CorpusEnv; root: string }>;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// The SAFE-WRITE tier's annotation: NOT read-only (it scaffolds a file) but explicitly NON-destructive
// (it never overwrites — no `--force`) and NON-idempotent (a second call would no-clobber-fail). The
// title/description carry the verdict-free contract; these hints carry the write-but-safe shape.
const SAFE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

// The verbosity control every read tool advertises (AC-013). `detailed` is the verbatim CLI payload;
// `concise` (the default) is the targeted slice an agent acts on, ≈⅓ the tokens.
const responseFormatInput = {
  response_format: z
    .enum(["concise", "detailed"])
    .optional()
    .describe(
      "concise (default) returns the relevant slice (~1/3 the tokens); detailed returns the verbatim CLI payload",
    ),
};

type Format = "concise" | "detailed";
const resolve_format = (value: Format | undefined): Format => value ?? "concise";

export function register_tools(server: McpServer, ctx: Ctx): void {
  // --- READ tier -----------------------------------------------------------------------------------
  server.registerTool(
    "corpus_get_status",
    {
      title: "Corpus workspace board",
      description:
        "The derived workspace board — specs, their tasks, and review status. Read-only; no verdict. " +
        "concise returns spec/task ids + review status + the triage lists; detailed the full board.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "status"), "plain", {
        format,
        slice: slice_status,
      });
    },
  );

  // Enumeration (AC-012): an agent without an id can list specs / tasks. There is no `corpus list` verb;
  // the board (`corpus status --json`) IS the enumeration source, so `corpus_list` projects it through a
  // `kind` filter. specs → the spec ids + status; tasks → every task across all specs + its review status.
  server.registerTool(
    "corpus_list",
    {
      title: "List specs or tasks",
      description:
        "Enumerate the workspace's specs or tasks (so an agent without an id can find one) — projected " +
        "from the board. `kind: specs` returns spec ids + status; `kind: tasks` returns task ids + their " +
        "spec + review status. Read-only; no verdict.",
      inputSchema: {
        kind: z
          .enum(["specs", "tasks"])
          .describe("which artifacts to enumerate"),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ kind, response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "status"), "plain", {
        format,
        slice: (data) => list_from_board(data, kind),
      });
    },
  );

  server.registerTool(
    "corpus_check_workspace",
    {
      title: "Check the whole workspace",
      description:
        "Run the Corpus checks contract over every spec + change plan. Returns diagnostics, never a " +
        "verdict. concise returns only the artifacts that carry a diagnostic; detailed every result.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "check"), "plain", {
        format,
        slice: slice_workspace_check,
      });
    },
  );

  // check_file is the ONE file-check path (AC-008): the former `validate_review_packet` was a thin alias
  // of this same `corpus check <file>` verb (a strict subset of reconcile), so it is dropped. A review
  // packet IS a valid input here — `corpus check` runs the review-file checks (C012 coverage, C013
  // verify-evidence) on it — but a clean result is NOT a full packet validation: the diff-aware facts
  // (out-of-scope, self-report, empty-evidence) come only from corpus_reconcile when a worktree exists.
  server.registerTool(
    "corpus_check_file",
    {
      title: "Check one artifact file (spec, review, or change-plan)",
      description:
        "Run the Corpus checks contract over one file via `corpus check`. Accepts a spec, a change-plan, " +
        "or a REVIEW packet (it runs the review-file checks C012/C013 on a review — a clean result here is " +
        "NOT full validation; the diff-aware facts come from corpus_reconcile). Do NOT pass a TASK packet: " +
        "`corpus check` would lint it as a spec and emit spurious warnings — use corpus_reconcile to " +
        "reconcile a task or corpus_get_task to read it. Returns diagnostics, never a verdict.",
      inputSchema: {
        path: z
          .string()
          .describe("workspace-relative path to the artifact file"),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ path, response_format }) => {
      const safe = confine_path(ctx.root, path);
      if (safe === null) {
        return tool_error(
          `refusing a path outside the workspace root: ${path}`,
        );
      }
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "check", [safe]), "plain", {
        format,
        slice: slice_file_check,
      });
    },
  );

  // --- RECONCILE tier ------------------------------------------------------------------------------
  // ONE reconcile tool (AC-007). scan = reconcile with no review packet present; the report carries
  // `hasReviewPacket`, so the scan-vs-reconcile distinction is DATA, not two tools. The single positional
  // is EITHER a task (`corpus review` resolves it to a task, keys coverage on the task scope, diffs the
  // worktree) OR a spec (the task-less 1:1 review-to-spec case, ADR-0103 — coverage on the spec's full
  // ACs, self-report from its `## Execution`). The CLI dispatches off the arg; the adapter must NOT
  // `task_stem` a spec id (that lowercases `SPEC-x` and breaks resolution), so a `spec` is validated +
  // passed verbatim while a `task` is normalized to its `tasks/<stem>.md` stem.
  server.registerTool(
    "corpus_reconcile",
    {
      title: "Reconcile a run vs its spec/task and the diff (no verdict)",
      description:
        "Reconcile a task (or a spec, the task-less 1:1 review-to-spec case) " +
        "against its spec and the worktree diff: coverage gaps, out-of-scope changes, empty-evidence Pass " +
        "rows, and self-report mismatches as facts + a structured human-attention list. This is the SAME " +
        "engine whether or not a review packet exists yet (the report carries hasReviewPacket — no separate " +
        "scan). Never issues a verdict — a human or an independent reviewer owns the result. If there is no " +
        'live worktree, returns a structured "not runnable here" result, not an error.',
      inputSchema: {
        task: z
          .string()
          .optional()
          .describe("task id or stem (the CLI reviews `tasks/<stem>.md`)"),
        spec: z
          .string()
          .optional()
          .describe(
            "spec id/slug for a task-less 1:1 review-to-spec reconcile — mutually exclusive with `task`",
          ),
        base: z
          .string()
          .optional()
          .describe("the base branch/commit to diff the worktree against"),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ task, spec, base }) => {
      // Exactly one of task/spec — the CLI takes a single positional.
      if ((task === undefined) === (spec === undefined)) {
        return tool_error("pass exactly one of `task` or `spec`");
      }
      // A spec id passes through VERBATIM (`SPEC-x` must not be lowercased); a task is normalized to its
      // reviewable stem. Both are validated as a single safe path segment before the subprocess runs.
      const positional = spec !== undefined ? spec : task_stem(task as string);
      if (!is_safe_segment(positional)) {
        return tool_error(
          `invalid ${spec !== undefined ? "spec id" : "task id/stem"}: ${spec ?? task}`,
        );
      }
      // A base ref legitimately contains `/`/`~` (origin/main, HEAD~1) — validate it as a base, and
      // REJECT an invalid one rather than silently dropping it (which would diff against the wrong base
      // with no error the agent could detect).
      if (typeof base === "string" && !is_safe_base(base)) {
        return tool_error(`invalid --base value: ${base}`);
      }
      const baseArg = typeof base === "string" ? base : undefined;
      return respond(
        invoke_corpus(ctx.env, "review", [positional], { base: baseArg }),
        "review",
      );
    },
  );

  // --- loader tools (the parsed-artifact projections, on `corpus show … --json`) -------------------
  server.registerTool(
    "corpus_get_task",
    {
      title: "Get a parsed task packet",
      description:
        "The task packet's scope, affected areas, claimed changes, frontmatter (id/source/status), and the " +
        "cross-root embedded spec slice (embeddedSpecId/embeddedRequirements) when present. " +
        "concise returns the scope-bearing identity slice; detailed the full packet. Read-only.",
      inputSchema: {
        task: z.string().describe("task id or stem"),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ task, response_format }) => {
      // Pass the id/slug through unchanged: `corpus show task` resolves either `pastebin` or
      // `TASK-pastebin` to the canonical tasks/TASK-<slug>.md, so pre-stripping the prefix (which
      // mismatched the file `corpus new task` writes) is both unnecessary and wrong.
      if (!is_safe_segment(task)) {
        return tool_error(`invalid task id/stem: ${task}`);
      }
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "show", ["task", task]), "plain", {
        format,
        slice: slice_show_task,
      });
    },
  );

  server.registerTool(
    "corpus_get_spec",
    {
      title: "Get a parsed spec",
      description:
        "The spec's frontmatter (incl. the living-spec snapshot/supersededBy fields), requirements (id + line + " +
        "named verify command), sections, and the append-only `## Execution` run-record (the durable history of " +
        "each change once tasks/reviews are ephemeral). concise drops the Execution prose + line " +
        "numbers; detailed returns it whole. Read-only.",
      inputSchema: {
        spec: z.string().describe("spec id (e.g. SPEC-auth)"),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ spec, response_format }) => {
      if (!is_safe_segment(spec)) {
        return tool_error(`invalid spec id: ${spec}`);
      }
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "show", ["spec", spec]), "plain", {
        format,
        slice: slice_show_spec,
      });
    },
  );

  server.registerTool(
    "corpus_get_review",
    {
      title: "Get a parsed review packet",
      description:
        "The review packet's status, coverage rows, verify blocks, and identity/staleness frontmatter (which " +
        "spec/task it reviews — a spec for the task-less 1:1 case — plus the fast-track reviewedSha/evidenceHash " +
        "pins). concise drops the evidence prose + staleness pins; detailed returns them. " +
        "Read-only; the verdict is the human's.",
      inputSchema: {
        task: z
          .string()
          .describe("task id or stem (the review is reviews/<stem>.md)"),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ task, response_format }) => {
      const stem = task_stem(task);
      if (!is_safe_segment(stem)) {
        return tool_error(`invalid task id/stem: ${task}`);
      }
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "show", ["review", stem]), "plain", {
        format,
        slice: slice_show_review,
      });
    },
  );

  server.registerTool(
    "corpus_get_checks",
    {
      title: "Get the checks contract",
      description:
        "The checks contract — version + the core checks (id/name/severity). What review must satisfy. " +
        "concise drops the human-readable check names; detailed returns them.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_corpus(ctx.env, "show", ["checks"]), "plain", {
        format,
        slice: slice_show_checks,
      });
    },
  );

  // --- SAFE-WRITE tier (AC-009) — verdict-free prepare ops -----------------------------------------
  register_safe_write_tools(server, ctx);
}

// The verdict-free safe-write tier (AC-009 / ADR-0077 D8). Each tool scaffolds ONE fresh artifact via a
// verdict-free CLI prepare op (`new spec` / `new task --from` / `promote`) and never overwrites (no
// `--force`), never writes the board, never writes a review result, and issues NO verdict. The slug/id is
// validated as a single safe path segment before the subprocess runs.
function register_safe_write_tools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    "corpus_scaffold_spec",
    {
      title: "Scaffold a fresh draft spec (prepare op — no verdict)",
      description:
        "VERDICT-FREE PREPARE OP: scaffold a fresh draft `specs/<slug>/spec.md` from the kit " +
        "template via `corpus new spec`. Creates the skeleton for an author to fill — it writes NO board, " +
        "NO review result, and issues NO verdict; it never overwrites an existing spec. Returns the created " +
        "path + spec id.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "the spec slug (letters/digits/._- only); becomes SPEC-<slug> at specs/<slug>/spec.md",
          ),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: SAFE_WRITE,
    },
    ({ slug }) => {
      if (!is_safe_segment(slug)) {
        return tool_error(`invalid spec slug: ${slug}`);
      }
      return respond(invoke_corpus(ctx.env, "new", ["spec", slug]));
    },
  );

  server.registerTool(
    "corpus_split_task",
    {
      title: "Split a spec into a task slice (prepare op — no verdict)",
      description:
        "VERDICT-FREE PREPARE OP: cut a task packet from a named spec via `corpus new task " +
        "--from <SPEC>`, copying the named requirement ids into its Scope (scope is COPIED, never invented). " +
        "Use when one spec fans out into parallel slices — 1:1 work needs no task. It writes NO board, NO " +
        "review result, and issues NO verdict; it never overwrites an existing packet. Returns the created " +
        "path + task id + scope.",
      inputSchema: {
        spec: z
          .string()
          .describe("the source spec id (e.g. SPEC-auth) to cut the task from"),
        scope: z
          .array(z.string())
          .optional()
          .describe(
            "requirement ids to copy into the task's Scope (e.g. [AC-001, AC-002]); empty = an unbounded task",
          ),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: SAFE_WRITE,
    },
    ({ spec, scope }) => {
      if (!is_safe_segment(spec)) {
        return tool_error(`invalid spec id: ${spec}`);
      }
      // Each scope id is a requirement id (AC-001) — validate every one as a safe segment so none can
      // smuggle a separator/flag into the comma-joined `--scope` value the CLI parses.
      const scopeIds = scope ?? [];
      for (const id of scopeIds) {
        if (!is_safe_segment(id)) {
          return tool_error(`invalid scope id: ${id}`);
        }
      }
      const flags: Record<string, string> = { "--from": spec };
      if (scopeIds.length > 0) {
        flags["--scope"] = scopeIds.join(",");
      }
      return respond(invoke_corpus(ctx.env, "new", ["task"], { flags }));
    },
  );

  server.registerTool(
    "corpus_scaffold_finding",
    {
      title: "Scaffold a candidate finding (prepare op — no verdict)",
      description:
        "VERDICT-FREE PREPARE OP: scaffold ONE candidate `findings/<slug>.md` from a finished " +
        "task/review id via `corpus promote`, pre-filling `from:` and leaving the what-we-learned body a " +
        "placeholder. It asserts NO learning of its own (status: candidate, never accepted), writes NO " +
        "board, and issues NO verdict — acceptance is the owner's. Backs the corpus_finding_candidate " +
        "prompt. It never overwrites an existing finding. Returns the created path + slug.",
      inputSchema: {
        from: z
          .string()
          .describe(
            "the task/review id the finding is promoted from (e.g. TASK-auth) — pre-fills `from:`",
          ),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: SAFE_WRITE,
    },
    ({ from }) => {
      if (!is_safe_segment(from)) {
        return tool_error(`invalid task/review id: ${from}`);
      }
      return respond(invoke_corpus(ctx.env, "promote", [from]));
    },
  );
}
