// The Suspec MCP tool surface — the v2 STORE surface (ADR-0137: artifacts are the agent's transient
// working memory in `~/.claude/state/<repo>/`, never repo files; no board, no workspace tree, no
// verdicts). Three tiers, all routed through the no-verdict envelope:
//   • READ — store projections over the CLI's read `--json` (status, store list, check, show).
//     The list/lint tools declare an outputSchema and take a `response_format` (concise|detailed,
//     AC-013): concise returns the relevant slice, detailed the verbatim payload. The loader
//     (suspec_get_artifact, over the CLI's store-resolving `show <kind> <ref>`) takes no
//     response_format: its payload IS the artifact projection — there is no noise slice.
//   • RECONCILE — the single `suspec_reconcile`: one engine (`suspec review <RUN>`), one tool. It
//     previews exactly what `suspec done` will gate on (artifact lint + evidence-vs-AC rows) without
//     closing anything; the implementer-vs-reviewer STANCE split lives in the prompts (prompts.ts).
//   • SAFE-WRITE — the verdict-free prepare tier (ADR-0084: prepare verbs re-aimed at the store):
//     scaffold_spec / split_task back the CLI's `write spec` / `new task --from`. Each SCAFFOLDS a
//     fresh STORE artifact; it is annotated non-verdict and read-adjacent (it creates an artifact,
//     never adjudicates one). See register_safe_write_tools for the full guarantee.
//
// Retired with the v2 pivot (no CLI counterpart): suspec_check_workspace (the workspace verdict is
// gone — `check` with no args is now the store lint, served by suspec_check_store) and
// suspec_scaffold_finding (`promote` now opens a GitHub issue and archives the finding — a network
// mutation, not a scaffold; findings enter via runs and promote via the CLI). The v1 get_task/
// get_spec/get_review loaders were retired while `show` was workspace-tree-bound; the CLI's `show`
// now resolves the STORE (spec|run|review|task|finding|intake by id-or-slug), so the loader face is
// RESTORED as the single suspec_get_artifact — without it a shell-less client (Claude Desktop,
// Cursor) has no way to read a store artifact at all (it cannot open ~/.claude/state paths).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type SuspecEnv, invoke_suspec } from "./suspec/invoke.ts";
import {
  confine_path,
  is_safe_segment,
  is_safe_intent,
} from "./roots.ts";
import { respond, tool_error, ENVELOPE_OUTPUT_SHAPE } from "./envelope.ts";
import {
  slice_status,
  slice_store_list,
  slice_store_lint,
  slice_file_check,
  slice_show_checks,
} from "./slices.ts";

export type Ctx = Readonly<{ env: SuspecEnv; root: string }>;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// The SAFE-WRITE tier's annotation: NOT read-only (it scaffolds a store file) but explicitly
// NON-destructive (it never overwrites — no `--force`, no `--launch`) and NON-idempotent (a second
// `new task` call would no-clobber-fail; `write spec` reuses the existing spec). The title/description
// carry the verdict-free contract; these hints carry the write-but-safe shape.
const SAFE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

// The verbosity control every read tool advertises (AC-013). `detailed` is the verbatim CLI payload;
// `concise` (the default) is the targeted slice an agent acts on (the .describe() string below is the
// model-facing copy).
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
    "suspec_get_status",
    {
      title: "Suspec store summary",
      description:
        `The store summary for the ONE repo this server instance is bound to (${ctx.root}): the active ` +
        `and archived store artifacts (specs, runs, reviews, findings, intakes) with their ages, plus ` +
        `the \`next\` attention ranking (live runs, gate gaps, triage debt, ready specs). Read-only; no ` +
        `verdict; switching repos means restarting the server with a different --workspace. concise ` +
        `drops the archived listing; detailed returns everything.`,
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_suspec(ctx.env, "status"), "plain", {
        format,
        slice: slice_status,
      });
    },
  );

  // Enumeration: an agent without a slug can list the store's artifacts. `suspec store list` is the
  // enumeration source (active + archived, each with kind + age); run slugs come from `run-<slug>.md`
  // filenames, spec ids from `spec-<slug>.md`.
  server.registerTool(
    "suspec_list",
    {
      title: "List the store's artifacts",
      description:
        "Enumerate the repo's store artifacts (so an agent without a slug can find one) via `suspec " +
        "store list`: active + archived, each with filename, kind (spec/run/review/finding/intake), and " +
        "age in days. A run slug is the `run-<slug>.md` filename stem. Read-only; no verdict.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_suspec(ctx.env, "store", ["list"]), "plain", {
        format,
        slice: slice_store_list,
      });
    },
  );

  // The store lint (replaces the retired suspec_check_workspace — there is no workspace tree and no
  // workspace verdict in v2; `suspec check` with no args lints the STORE's artifacts for this repo).
  server.registerTool(
    "suspec_check_store",
    {
      title: "Lint the store's artifacts",
      description:
        "Run the checks contract over the repo's STORE artifacts via `suspec check` (no file): every " +
        "run record, its driving spec, review packets, and evidence records (a forged cli-verified " +
        "claim is a hard error). Returns diagnostics plus a derived human-attention list (each " +
        "diagnostic as a structured artifact-lint item), never a verdict. concise returns only the " +
        "artifacts that carry a diagnostic; detailed every result.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_suspec(ctx.env, "check"), "store-lint", {
        format,
        slice: slice_store_lint,
      });
    },
  );

  server.registerTool(
    "suspec_check_file",
    {
      title: "Check one artifact file (spec, review, or change-plan)",
      description:
        "Run the Suspec checks contract over one REPO file via `suspec check <file>`. Dispatches on " +
        "the file's frontmatter type: a spec runs the core spec checks, a review packet the C012/C013 " +
        "review checks, a change-plan the C010/C011 checks. The path is confined to the repo root " +
        "this server is bound to, so this reaches repo-resident files only (e.g. a promoted spec). " +
        "Store artifacts live in the user-level store, out of this tool's reach — the run/spec chain " +
        "is linted via suspec_check_store; a STORE change-plan (`new change-plan` scaffolds into the " +
        "store) currently has no MCP lint face (check it via the CLI: `suspec check <store-path>`). " +
        "Returns diagnostics, never a verdict.",
      inputSchema: {
        path: z.string().describe("repo-relative path to the artifact file"),
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
      return respond(invoke_suspec(ctx.env, "check", [safe]), "plain", {
        format,
        slice: slice_file_check,
      });
    },
  );

  server.registerTool(
    "suspec_get_checks",
    {
      title: "Get the checks contract",
      description:
        "The checks contract — version + the core checks (id/name/severity). What the artifact lint " +
        "and review reconcile hold artifacts to. concise drops the human-readable check names; " +
        "detailed returns them.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(invoke_suspec(ctx.env, "show", ["checks"]), "plain", {
        format,
        slice: slice_show_checks,
      });
    },
  );

  // The store loader (the restored get_* face): ONE tool over the CLI's store-resolving
  // `show <kind> <ref>`. For a shell-less client this is the only way to READ a store artifact —
  // suspec_get_status/suspec_list name the filenames, this loads one. No response_format: the
  // projection IS the payload (nothing to slice without gutting the tool's purpose).
  server.registerTool(
    "suspec_get_artifact",
    {
      title: "Load one store artifact (spec, run, review, task, finding, or intake)",
      description:
        "Load ONE store artifact by id or slug via the CLI's store-resolving `suspec show <kind> " +
        "<ref>`: spec/task/review return the parsed projection (a spec's requirements + verify " +
        "commands and its `## Execution` record; a task's scope; a review packet's coverage rows), " +
        "run/intake the honest frontmatter+body split, finding its severity/areas/body. Resolves " +
        "active artifacts first, `archive/` as fallback (a read never resurrects). The ref is an id " +
        "or slug (e.g. SPEC-auth, or the `run-<slug>.md` stem), never a path — enumerate via " +
        "suspec_list. Read-only; no verdict.",
      inputSchema: {
        kind: z
          .enum(["spec", "run", "review", "task", "finding", "intake"])
          .describe("the artifact kind (the `<kind>-*.md` filename prefix in the store)"),
        ref: z
          .string()
          .describe("the artifact's frontmatter id or filename slug (never a path)"),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ kind, ref }) => {
      // A ref is an id/slug, never a path — same boundary the CLI enforces (is_safe_segment there too).
      if (!is_safe_segment(ref)) {
        return tool_error(`invalid ${kind} ref: ${ref}`);
      }
      return respond(invoke_suspec(ctx.env, "show", [kind, ref]));
    },
  );

  // --- RECONCILE tier ------------------------------------------------------------------------------
  server.registerTool(
    "suspec_reconcile",
    {
      title: "Reconcile a store run vs its spec (no verdict)",
      description:
        "Reconcile a STORE run against its driving spec via `suspec review <RUN>`: (1) artifact lint — " +
        "the run record, its spec, the review packet if one exists, every evidence record; (2) the " +
        "evidence-vs-AC rows — every spec AC against the run's evidence records (verified / stale / " +
        "failing / missing), the SAME rows `suspec done` gates on, previewed without closing anything. " +
        "Returns facts + a derived human-attention list; never a verdict — the human owns the result " +
        "(`suspec done` is the gate). If the run does not exist in the store, returns a structured " +
        '"no such run" result, not an error.',
      inputSchema: {
        run: z
          .string()
          .describe(
            "the store run slug (the `run-<slug>.md` filename stem — list runs via suspec_get_status or suspec_list)",
          ),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ run }) => {
      // A run ref is a slug, never a path — validated as a single safe segment before the subprocess.
      if (!is_safe_segment(run)) {
        return tool_error(`invalid run slug: ${run}`);
      }
      return respond(invoke_suspec(ctx.env, "review", [run]), "review");
    },
  );

  // --- SAFE-WRITE tier — verdict-free prepare ops ----------------------------------------------------
  register_safe_write_tools(server, ctx);
}

// The verdict-free safe-write tier (ADR-0084 prepare verbs, re-aimed at the store). Each tool scaffolds
// ONE fresh STORE artifact via a verdict-free CLI prepare op (`write spec` / `new task --from`) and
// never overwrites (no `--force`), never launches a runner (no `--launch`), never writes a review
// result, and issues NO verdict. Every input is validated before the subprocess runs.
function register_safe_write_tools(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    "suspec_scaffold_spec",
    {
      title: "Scaffold a draft store spec from an intent (prepare op — no verdict)",
      description:
        "VERDICT-FREE PREPARE OP: scaffold a fresh draft STORE spec (`spec-<slug>.md`) from a one-line " +
        "intent via `suspec write spec` — frontmatter (status: draft, base_sha = repo HEAD), the intent " +
        "line, and ONE empty AC with a Verify placeholder. The CLI authors NO requirement content; an " +
        "author fills the ACs. It never dispatches a runner (no --launch) and reuses (never overwrites) " +
        "an existing spec for the same slug. Returns the created spec id + store path.",
      inputSchema: {
        intent: z
          .string()
          .describe(
            'the one-line intent that seeds the spec (e.g. "add dark mode to settings"); the CLI derives the slug',
          ),
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: SAFE_WRITE,
    },
    ({ intent }) => {
      const cleaned = intent.trim().replace(/\s+/g, " ");
      if (!is_safe_intent(cleaned)) {
        return tool_error(`invalid intent: ${intent}`);
      }
      return respond(invoke_suspec(ctx.env, "write", ["spec", cleaned]));
    },
  );

  server.registerTool(
    "suspec_split_task",
    {
      title: "Split a store spec into a task slice (prepare op — no verdict)",
      description:
        "VERDICT-FREE PREPARE OP: cut a STORE task slice (`task-<slug>.md`) from a store spec via " +
        "`suspec new task --from <SPEC>`, copying the named requirement ids into its Scope (scope is " +
        "COPIED, never invented). Use when one spec fans out into parallel slices — 1:1 work needs no " +
        "task (implement against the spec; record the run in its `## Execution`). It never overwrites " +
        "an existing slice. Returns the created store path + task id + scope.",
      inputSchema: {
        spec: z
          .string()
          .describe(
            "the source spec id or slug (e.g. SPEC-auth), resolved against the store's spec-*.md files",
          ),
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
      return respond(invoke_suspec(ctx.env, "new", ["task"], { flags }));
    },
  );
}
