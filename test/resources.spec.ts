import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { create_server } from "../src/server.ts";

// Exercises the resource surface — ONE fixed URI, the checks contract — over the in-memory
// transport, against the stub. STUB_LOG records every subprocess argv.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const stubBin = join(fixtures, "stub-suspec.mjs");
const errorBin = join(fixtures, "error-suspec.mjs"); // always emits a structured CLI error
const nonjsonBin = join(fixtures, "nonjson-suspec.mjs"); // emits non-JSON → launch-error

let root: string;
let logPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suspec-mcp-res-"));
  logPath = `${root}.log`;
  process.env.STUB_LOG = logPath;
});
afterEach(() => {
  delete process.env.STUB_LOG;
  rmSync(root, { recursive: true, force: true });
  if (existsSync(logPath)) {
    rmSync(logPath);
  }
});

function invocations(): string[][] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function connect(
  bin: string = stubBin,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = create_server({ env: { bin, cwd: root } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const firstText = (r: { contents: { text?: string }[] }): string =>
  r.contents[0]?.text ?? "";

// Symmetric to the tool sweep (server.spec INV-002): no resource body may carry a suspec-mcp-AUTHORED
// verdict key. The resource serves the CLI's data verbatim, so no forbidden key should appear.
const FORBIDDEN_VERDICT_KEYS = [
  "verdict",
  "pass",
  "fail",
  "merge",
  "decision",
  "approved",
  "mergeAllowed",
];
function collect_keys(obj: unknown, acc: string[] = []): string[] {
  if (Array.isArray(obj)) {
    for (const v of obj) collect_keys(v, acc);
  } else if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      acc.push(k);
      collect_keys(v, acc);
    }
  }
  return acc;
}

describe("suspec-mcp resources", () => {
  it("lists exactly the checks-contract resource and no templated resource", async () => {
    const { client, close } = await connect();
    try {
      const fixed = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(fixed).toEqual(["suspec://checks"]);
      const templates = (await client.listResourceTemplates()).resourceTemplates;
      expect(templates).toEqual([]);
    } finally {
      await close();
    }
  });

  it("reads the checks contract via `check --contract` — a read verb only, never anything else", async () => {
    const { client, close } = await connect();
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://checks" }),
      );
      const parsed = JSON.parse(text) as {
        version: string;
        checks: { id: string }[];
      };
      expect(parsed.version).toBe("0.17.0");
      expect(parsed.checks.length).toBeGreaterThan(0);
      expect(invocations()).toEqual([["check", "--contract", "--json"]]);
    } finally {
      await close();
    }
  });

  it("no resource body carries a suspec-mcp-authored verdict key (INV-002, symmetric to the tool sweep)", async () => {
    const { client, close } = await connect();
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://checks" }),
      );
      const keys = collect_keys(JSON.parse(text));
      for (const forbidden of FORBIDDEN_VERDICT_KEYS) {
        expect(
          keys,
          `suspec://checks must not author a "${forbidden}" key`,
        ).not.toContain(forbidden);
      }
    } finally {
      await close();
    }
  });

  it("renders a structured CLI error as the resource body (body_of structured-error branch)", async () => {
    const { client, close } = await connect(errorBin);
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://checks" }),
      );
      expect(text).toContain("simulated structured error");
    } finally {
      await close();
    }
  });

  it("renders an adapter launch-error as the resource body when the CLI cannot run (body_of launch-error branch)", async () => {
    const { client, close } = await connect(nonjsonBin);
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://checks" }),
      );
      expect(text).toMatch(/"error": ?"adapter"/);
      expect(text).toMatch(/no parseable JSON/);
    } finally {
      await close();
    }
  });
});
