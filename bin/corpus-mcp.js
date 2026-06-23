#!/usr/bin/env node
// Launcher for the Corpus MCP stdio server. Dev checkout runs the TypeScript source directly via Node's
// native type stripping (no build step, Node >= 22.6); a published install runs the bundled dist. The
// server speaks the MCP protocol over stdio, so this inherits stdio and forwards signals.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const sourceEntry = join(here, "../src/index.ts");
const builtEntry = join(here, "../dist/index.js");
const args = process.argv.slice(2);

let res;
if (existsSync(sourceEntry)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 6)) {
    console.error(
      "Error: running corpus-mcp from source needs Node.js >= 22.6 (or run `pnpm build`).",
    );
    console.error(`Current version: ${process.versions.node}`);
    process.exit(1);
  }
  res = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      sourceEntry,
      ...args,
    ],
    { stdio: "inherit" },
  );
} else {
  res = spawnSync(process.execPath, [builtEntry, ...args], {
    stdio: "inherit",
  });
}

if (res.signal) {
  process.kill(process.pid, res.signal);
} else {
  process.exit(res.status ?? 0);
}
