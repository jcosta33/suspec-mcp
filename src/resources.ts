// The application-driven context surface: ONE fixed URI — the checks contract, served from the same
// allow-listed `suspec check --contract` invocation the suspec_get_checks tool uses (so keeping it
// costs nothing and it can never drift from the tool). Read-only.

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import { invoke_suspec, type SuspecResult } from "./suspec/invoke.ts";
import type { Ctx } from "./tools.ts";

const JSON_MIME = "application/json";

// Render a SuspecResult's payload as the resource body (the CLI data, or the structured error).
function body_of(result: SuspecResult): string {
  if (result.kind === "ok") {
    return JSON.stringify(result.data, null, 2);
  }
  if (result.kind === "structured-error") {
    return JSON.stringify(result.error, null, 2);
  }
  return JSON.stringify({ error: "adapter", message: result.message }, null, 2);
}

export function register_resources(server: McpServer, ctx: Ctx): void {
  server.registerResource(
    "checks",
    "suspec://checks",
    {
      title: "Checks contract",
      description:
        "The checks contract — the contract version + every core check's id, name, and severity.",
      mimeType: JSON_MIME,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: body_of(
            invoke_suspec(ctx.env, "check", [], { bare: ["--contract"] }),
          ),
        },
      ],
    }),
  );
}
