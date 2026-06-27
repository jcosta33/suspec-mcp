// Compose the Corpus MCP server: register the read/reconcile tools + resources (+ prompts in slice 4)
// onto a fresh McpServer. Pure construction — no transport here, so tests can drive it over an
// in-memory transport.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { register_tools, type Ctx } from "./tools.ts";
import { register_resources } from "./resources.ts";
import { register_prompts } from "./prompts.ts";

export function create_server(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "corpus-mcp", version: "0.2.0" });
  register_tools(server, ctx);
  register_resources(server, ctx);
  register_prompts(server);
  return server;
}
