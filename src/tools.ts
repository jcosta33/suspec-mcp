// The Suspec MCP tool surface — the CLI's two invocations (ADR-0143), path-explicit, behind the
// no-verdict envelope:
//   • suspec_check_file — run the checks contract over ONE artifact the caller names by path. The
//     artifact's kind is read from its own frontmatter; a review packet's companions are explicit
//     `spec`/`task` full-path params, passed through unchanged.
//   • suspec_get_checks — the checks contract itself (`suspec check --contract`).
// Both tools relay the CLI's recorded facts — diagnostics, severity level, exit code — never a verdict.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute } from "node:path";

import { type SuspecEnv, invoke_suspec } from "./suspec/invoke.ts";
import { respond, tool_error, ENVELOPE_OUTPUT_SHAPE } from "./envelope.ts";
import { slice_check_file, slice_contract } from "./slices.ts";

export type Ctx = Readonly<{ env: SuspecEnv }>;

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
      "concise (default) returns the relevant slice; detailed returns the verbatim CLI payload",
    ),
};

type Format = "concise" | "detailed";
const resolve_format = (value: Format | undefined): Format =>
  value ?? "concise";

function is_full_path(value: string): boolean {
  return (
    isAbsolute(value) &&
    value.length > 0 &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)
  );
}

function path_error(role: "artifact" | "spec" | "task") {
  return tool_error(
    `${role} path must be a full absolute path with no control, format, or line-separator characters`,
  );
}

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
        "ok:false with the CLI's message). Every path — the artifact and both companions — must be a " +
        "full path and is passed to the CLI unchanged. This single-file surface cannot run cross-file C002; " +
        "use the CLI directly for duplicate-ID checks across a file set. Returns the CLI's diagnostics, " +
        "severity level, and exit code (0 clean, 1 warnings, 2 blocking) — facts, never a verdict.",
      inputSchema: {
        path: z.string().describe("full path to the artifact file"),
        spec: z
          .string()
          .optional()
          .describe(
            "full path to the source spec a review packet reconciles against (required for a review)",
          ),
        task: z
          .string()
          .optional()
          .describe(
            "full path to the task packet whose scope keys the review's coverage (required exactly when the review's frontmatter names a `task:`)",
          ),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    async ({ path, spec, task, response_format }) => {
      if (!is_full_path(path)) {
        return path_error("artifact");
      }
      const flags: Record<string, string> = {};
      if (spec !== undefined) {
        if (!is_full_path(spec)) {
          return path_error("spec");
        }
        flags["--spec"] = spec;
      }
      if (task !== undefined) {
        if (!is_full_path(task)) {
          return path_error("task");
        }
        flags["--task"] = task;
      }
      const format = resolve_format(response_format);
      return respond(await invoke_suspec(ctx.env, "check", [path], { flags }), {
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
    async ({ response_format }) => {
      const format = resolve_format(response_format);
      return respond(
        await invoke_suspec(ctx.env, "check", [], { bare: ["--contract"] }),
        { format, slice: slice_contract },
      );
    },
  );
}
