import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The shipped entry point (package.json `bin.suspec-mcp`) — what a real install/npx invocation runs.
// stdio.spec.ts proves the server itself serves over real stdio; this proves the LAUNCHER in front of
// it starts that server, inherits its stdio, and forwards args, so the thing users actually run is
// exercised, not just the code behind it. Deterministic: stub `suspec` binary + a temp workspace.
// The launcher has TWO live branches: the dev checkout runs src/ via type stripping (the MCP test
// below), and a published install — package.json `files` ships no src/ — runs dist/index.js (the
// installed-tree test below, against a copied launcher in a src-less tree).
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, "..", "bin", "suspec-mcp.js");
const stubBin = join(here, "fixtures", "stub-suspec.mjs");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suspec-mcp-launcher-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(
    join(root, "specs", "x.md"),
    "---\ntype: spec\nid: SPEC-x\n---\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bin/suspec-mcp.js launcher", () => {
  it("starts the server, lists the two tools, and forwards a tool call", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [launcher, "--workspace", root, "--suspec-bin", stubBin],
    });
    const client = new Client({ name: "launcher-test", version: "0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["suspec_check_file", "suspec_get_checks"]);

      const check = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/x.md" },
      })) as {
        structuredContent: {
          noVerdictIssued: boolean;
          data: { diagnostics: unknown[] };
        };
      };
      expect(check.structuredContent.noVerdictIssued).toBe(true);
      expect(check.structuredContent.data.diagnostics.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("falls back to dist/index.js in an installed tree (no src/), forwarding args and the exit status", () => {
    // A real install's layout: bin/ + dist/ + package.json, NO src/ — so the launcher's
    // `existsSync(sourceEntry)` is false and it must spawn the built entry.
    const pkg = mkdtempSync(join(tmpdir(), "suspec-mcp-installed-"));
    try {
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), '{"type":"module"}\n');
      copyFileSync(launcher, join(pkg, "bin", "suspec-mcp.js"));
      // A stand-in dist entry: echoes its argv (proves forwarding + inherited stdout) and exits
      // non-zero (proves the launcher propagates the child's exit status).
      writeFileSync(
        join(pkg, "dist", "index.js"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n",
      );
      const res = spawnSync(
        process.execPath,
        [
          join(pkg, "bin", "suspec-mcp.js"),
          "--workspace",
          "/w",
          "--suspec-bin",
          "suspec",
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(res.stdout)).toEqual([
        "--workspace",
        "/w",
        "--suspec-bin",
        "suspec",
      ]);
      expect(res.status).toBe(7);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });
});
