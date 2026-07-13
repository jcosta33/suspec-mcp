// Compose the Suspec MCP server: register the check tools and the checks-contract resource onto a
// fresh McpServer. Pure construction — no transport here, so tests can drive it over an in-memory
// transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { register_tools, type Ctx } from "./tools.ts";
import { register_resources } from "./resources.ts";
import { require_supported_contract } from "./suspec/compatibility.ts";

export async function create_server(ctx: Ctx): Promise<McpServer> {
  await require_supported_contract(ctx.env);
  const server = new McpServer({ name: "suspec-mcp", version: "0.5.0" });
  register_tools(server, ctx);
  register_resources(server, ctx);
  return server;
}
