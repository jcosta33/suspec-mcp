import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The server actually starts and serves over REAL stdio (not just the in-memory transport).
// Deterministic: the spawned server is pointed at the stub `suspec` binary and a temporary root.
const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "src", "index.ts");
const stubBin = join(here, "fixtures", "stub-suspec.mjs");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suspec-mcp-stdio-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  writeFileSync(
    join(root, "specs", "x.md"),
    "---\ntype: spec\nid: SPEC-x\n---\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("real stdio transport", () => {
  it("spawns the server over stdio, lists the two tools, and serves both tool calls", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        serverEntry,
        "--suspec-bin",
        stubBin,
      ],
    });
    const client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["suspec_check", "suspec_get_checks"]);

      const checks = (await client.callTool({
        name: "suspec_get_checks",
        arguments: {},
      })) as {
        structuredContent: {
          data: { version: string };
        };
      };
      expect(checks.structuredContent.data.version).toBe("0.18.0");

      const check = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [join(root, "specs", "x.md")] },
      })) as {
        structuredContent: {
          data: { diagnostics: unknown[] }[];
        };
      };
      expect(check.structuredContent.data[0].diagnostics.length).toBeGreaterThan(
        0,
      );
    } finally {
      await client.close();
    }
  });
});
