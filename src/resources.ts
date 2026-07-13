// The application-driven context surface: ONE fixed URI — the checks contract, served from the same
// allow-listed `suspec check --contract` invocation the suspec_get_checks tool uses (so keeping it
// costs nothing and it can never drift from the tool). Read-only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { invoke_suspec } from "./suspec/invoke.ts";
import { ContractSchema } from "./suspec/contract.ts";
import { require_supported_contract_result } from "./suspec/compatibility.ts";
import type { Ctx } from "./tools.ts";

const JSON_MIME = "application/json";

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
    async (uri) => {
      const result = await invoke_suspec(ctx.env, "check", [], {
        bare: ["--contract"],
        schema: ContractSchema,
        output: "json",
      });
      const data = require_supported_contract_result(result);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: JSON_MIME,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );
}
