#!/usr/bin/env node
// Entry: resolve the `suspec` binary, build the server, and connect stdio. Stdout is the MCP
// protocol, so diagnostics go to stderr only.

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { create_server } from "./server.ts";

export type Config = Readonly<{ bin: string }>;

const RETIRED_WORKSPACE_MESSAGE =
  "--workspace and SUSPEC_WORKSPACE are retired; suspec-mcp tools require explicit full artifact paths";

// Config order for the CLI binary: flag, environment, then `suspec` on PATH.
export function parse_config(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Config {
  if (env.SUSPEC_WORKSPACE !== undefined) {
    throw new Error(RETIRED_WORKSPACE_MESSAGE);
  }
  let bin = env.SUSPEC_BIN ?? "suspec";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--workspace" || token.startsWith("--workspace=")) {
      throw new Error(RETIRED_WORKSPACE_MESSAGE);
    }
    if (token.startsWith("--suspec-bin=")) {
      const value = token.slice("--suspec-bin=".length);
      if (value.length > 0) {
        bin = value;
      }
      continue;
    }
    if (token === "--suspec-bin") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        bin = value;
        index += 1;
      }
    }
  }
  return { bin };
}

/* v8 ignore start -- the process entry; create_server + parse_config are unit-tested directly */
async function main(): Promise<void> {
  const { bin } = parse_config(process.argv.slice(2), process.env);
  const server = create_server({ env: { bin, cwd: process.cwd() } });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`suspec-mcp: ready (suspec=${bin})\n`);
}

function is_main_module(metaUrl: string, entry: string | undefined): boolean {
  return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}
if (is_main_module(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `suspec-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
/* v8 ignore stop */
