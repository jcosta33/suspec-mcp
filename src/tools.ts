// The Suspec MCP tool surface:
//   • suspec_check — run one CLI process over an ordered artifact path set. A lone review may carry
//     explicit spec/task companions.
//   • suspec_get_checks — the checks contract itself (`suspec check --contract`).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute } from "node:path";

import {
  distinct_primary_paths,
  type SuspecEnv,
  invoke_suspec,
} from "./suspec/invoke.ts";
import { invoke_supported_contract } from "./suspec/compatibility.ts";
import { respond, tool_error, ENVELOPE_OUTPUT_SHAPE } from "./envelope.ts";
import { slice_check_results, slice_contract } from "./slices.ts";

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
  responseFormat: z
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
    "suspec_check",
    {
      title: "Check Suspec artifacts",
      description:
        "Run one `suspec check` process over an ordered non-empty array of absolute artifact paths. " +
        "Batching enables cross-file checks such as C002. A review must be the only primary path and " +
        "may receive absolute specPath and taskPath companions. Returns the CLI reports in output order.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe("ordered non-empty array of absolute artifact paths"),
        specPath: z
          .string()
          .optional()
          .describe(
            "absolute source-spec path for a single review target",
          ),
        taskPath: z
          .string()
          .optional()
          .describe(
            "absolute task-packet path for a single review target",
          ),
        ...responseFormatInput,
      },
      outputSchema: ENVELOPE_OUTPUT_SHAPE,
      annotations: READ_ONLY,
    },
    async ({ paths, specPath, taskPath, responseFormat }) => {
      for (const path of paths) {
        if (!is_full_path(path)) {
          return path_error("artifact");
        }
      }
      const flags: Record<string, string> = {};
      if (
        (specPath !== undefined || taskPath !== undefined) &&
        distinct_primary_paths(paths, ctx.env.cwd).length !== 1
      ) {
        return tool_error(
          "specPath/taskPath are valid only when paths contains exactly one review target",
        );
      }
      if (specPath !== undefined) {
        if (!is_full_path(specPath)) {
          return path_error("spec");
        }
        flags["--spec"] = specPath;
      }
      if (taskPath !== undefined) {
        if (!is_full_path(taskPath)) {
          return path_error("task");
        }
        flags["--task"] = taskPath;
      }
      const format = resolve_format(responseFormat);
      return respond(await invoke_suspec(ctx.env, "check", paths, {
        flags,
        expected: "reports",
      }), {
        format,
        slice: slice_check_results,
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
    async ({ responseFormat }) => {
      const format = resolve_format(responseFormat);
      return respond(
        await invoke_supported_contract(ctx.env),
        { format, slice: slice_contract },
      );
    },
  );
}
