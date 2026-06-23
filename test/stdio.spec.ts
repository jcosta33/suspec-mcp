import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// AC-001 — the server actually starts and serves over REAL stdio (not just the in-memory transport).
// Deterministic: the spawned server is pointed at the stub `corpus` binary and a temp workspace.
const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "src", "index.ts");
const stubBin = join(here, "fixtures", "stub-corpus.mjs");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corpus-mcp-stdio-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(join(root, "specs", "x.md"), "# x");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("real stdio transport (AC-001)", () => {
  it("spawns the server over stdio, lists tools, and serves a tool call", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        serverEntry,
        "--workspace",
        root,
        "--corpus-bin",
        stubBin,
      ],
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("corpus_get_status");
      expect(tools).toContain("corpus_get_task");
      expect(tools).toHaveLength(10);

      const result = (await client.callTool({
        name: "corpus_get_status",
        arguments: {},
      })) as {
        structuredContent: {
          noVerdictIssued: boolean;
          data: { specs: unknown[] };
        };
      };
      expect(result.structuredContent.noVerdictIssued).toBe(true);
      expect(result.structuredContent.data.specs.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
