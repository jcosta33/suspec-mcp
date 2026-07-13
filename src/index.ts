#!/usr/bin/env node
// Entry: resolve the `suspec` binary, build the server, and connect stdio. Stdout is the MCP
// protocol, so diagnostics go to stderr only.

import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { create_server } from "./server.ts";

export type Config = Readonly<{ bin: string }>;

// Config order for the CLI binary: flag, environment, then `suspec` on PATH.
export function parse_config(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Config {
  let bin = env.SUSPEC_BIN ?? "suspec";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--suspec-bin=")) {
      const value = token.slice("--suspec-bin=".length);
      if (value.length === 0) {
        throw new Error("--suspec-bin requires a non-empty path");
      }
      bin = value;
      continue;
    }
    if (token === "--suspec-bin") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--suspec-bin requires a non-empty path");
      }
      bin = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return { bin };
}

/* v8 ignore start -- the process entry; create_server + parse_config are unit-tested directly */
async function main(): Promise<void> {
  const { bin } = parse_config(process.argv.slice(2), process.env);
  const server = await create_server({ env: { bin, cwd: process.cwd() } });
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
