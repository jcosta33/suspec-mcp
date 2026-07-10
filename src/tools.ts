// The Suspec MCP tool surface — the CLI's two invocations (ADR-0143), path-explicit, behind the
// no-verdict envelope:
//   • suspec_check_file — run the checks contract over ONE artifact the caller names by path. The
//     artifact's kind is read from its own frontmatter; a review packet's companions are explicit
//     `spec`/`task` path params. Every path (primary AND companions) is confined to the workspace
//     root this server is bound to.
//   • suspec_get_checks — the checks contract itself (`suspec check --contract`).
// Both tools relay the CLI's recorded facts — diagnostics, severity level, exit code — never a verdict.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type SuspecEnv, invoke_suspec } from "./suspec/invoke.ts";
import { confine_path } from "./roots.ts";
import { respond, tool_error, ENVELOPE_OUTPUT_SHAPE } from "./envelope.ts";
import { slice_check_file, slice_contract } from "./slices.ts";

export type Ctx = Readonly<{ env: SuspecEnv; root: string }>;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// The verbosity control every tool advertises. `detailed` is the verbatim CLI payload; `concise`
// (the default) is the targeted slice an agent acts on (the .describe() string below is the
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
  server.registerTool(
    "suspec_check_file",
    {
      title: "Check one Suspec artifact file",
      description:
        "Run the Suspec checks contract over ONE artifact file via `suspec check <artifact>`. The " +
        "artifact's kind is read from its own frontmatter `type:`: a spec runs the spec checks, a " +
        "change-plan the plan checks, and a review packet reconciles against the companion files you " +
        "pass explicitly — `spec` is always required for a review, and `task` is required exactly when " +
        "the review's frontmatter names a `task:` (the CLI refuses a missing or unreferenced companion " +
        "with a blocking error rather than silently checking less; that refusal surfaces here as " +
        "ok:false with the CLI's message). Every path — the artifact and both companions — is confined " +
        "to the workspace root this server is bound to. Returns the CLI's diagnostics, severity level, " +
        "and exit code (0 clean, 1 warnings, 2 blocking) — facts, never a verdict.",
      inputSchema: {
        path: z
          .string()
          .describe("workspace-relative path to the artifact file to check"),
        spec: z
          .string()
          .optional()
          .describe(
            "workspace-relative path to the source spec a review packet reconciles against (required for a review)",
          ),
        task: z
          .string()
          .optional()
          .describe(
            "workspace-relative path to the task packet whose scope keys the review's coverage (required exactly when the review's frontmatter names a `task:`)",
          ),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ path, spec, task, response_format }) => {
      const safe = confine_path(ctx.root, path);
      if (safe === null) {
        return tool_error(
          `refusing a path outside the workspace root: ${path}`,
        );
      }
      // The companions are paths the CLI will read too — confined exactly like the primary.
      const flags: Record<string, string> = {};
      if (spec !== undefined) {
        const safeSpec = confine_path(ctx.root, spec);
        if (safeSpec === null) {
          return tool_error(
            `refusing a spec path outside the workspace root: ${spec}`,
          );
        }
        flags["--spec"] = safeSpec;
      }
      if (task !== undefined) {
        const safeTask = confine_path(ctx.root, task);
        if (safeTask === null) {
          return tool_error(
            `refusing a task path outside the workspace root: ${task}`,
          );
        }
        flags["--task"] = safeTask;
      }
      const format = resolve_format(response_format);
      return respond(invoke_suspec(ctx.env, "check", [safe], { flags }), {
        format,
        slice: slice_check_file,
      });
    },
  );

  server.registerTool(
    "suspec_get_checks",
    {
      title: "Get the checks contract",
      description:
        "The checks contract the CLI holds artifacts to, via `suspec check --contract`: the contract " +
        "version plus every core check's id, name, and severity. concise drops the human-readable " +
        "check names; detailed returns them.",
      inputSchema: { ...responseFormatInput },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(
        invoke_suspec(ctx.env, "check", [], { bare: ["--contract"] }),
        { format, slice: slice_contract },
      );
    },
  );
}
