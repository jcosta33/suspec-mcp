import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { create_server } from "../src/server.ts";

// Exercises the resource surface (fixed URIs only in v2 — the templated artifact resources retired
// with the store pivot) over the in-memory transport, against the stub. STUB_LOG records every
// subprocess argv.
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
  const server = create_server({ env: { bin, cwd: root }, root });
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
// verdict key. Resources serve the CLI's data verbatim (only `workspace` wraps it, adding
// noVerdictIssued) — so no forbidden key should appear.
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
  it("lists the fixed resources and NO templated artifact resource (retired with the store pivot)", async () => {
    const { client, close } = await connect();
    try {
      const fixed = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(fixed).toEqual([
        "suspec://checks",
        "suspec://status",
        "suspec://workspace",
      ]);
      const templates = (await client.listResourceTemplates()).resourceTemplates;
      expect(templates).toEqual([]);
    } finally {
      await close();
    }
  });

  it("no resource body carries a suspec-mcp-authored verdict key (INV-002, symmetric to the tool sweep)", async () => {
    const { client, close } = await connect();
    try {
      for (const uri of [
        "suspec://workspace",
        "suspec://status",
        "suspec://checks",
      ]) {
        const text = firstText(await client.readResource({ uri }));
        const keys = collect_keys(JSON.parse(text));
        for (const forbidden of FORBIDDEN_VERDICT_KEYS) {
          expect(
            keys,
            `${uri} must not author a "${forbidden}" key`,
          ).not.toContain(forbidden);
        }
      }
    } finally {
      await close();
    }
  });

  it("reads the fixed resources (workspace / status / checks)", async () => {
    const { client, close } = await connect();
    try {
      const workspace = firstText(
        await client.readResource({ uri: "suspec://workspace" }),
      );
      expect(workspace).toContain('"mode": "read+reconcile+scaffold, no verdict"');
      // the binding names the repo root + carries the store summary
      expect(workspace).toContain('"repoRoot"');
      expect(workspace).toContain("run-feat.md");
      expect(
        firstText(await client.readResource({ uri: "suspec://status" })),
      ).toContain('"next"');
      expect(
        firstText(await client.readResource({ uri: "suspec://checks" })),
      ).toContain('"version"');
      // only read verbs ran (status / show checks) — never a mutation
      for (const argv of invocations()) {
        expect(["status", "show"]).toContain(argv[0]);
      }
    } finally {
      await close();
    }
  });

  it("renders a structured CLI error as the resource body (body_of structured-error branch)", async () => {
    const { client, close } = await connect(errorBin);
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://status" }),
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
        await client.readResource({ uri: "suspec://status" }),
      );
      expect(text).toMatch(/"error": ?"adapter"/);
      expect(text).toMatch(/no parseable JSON/);
    } finally {
      await close();
    }
  });

  it("the workspace resource degrades to store:null when the CLI errors (never a thrown read)", async () => {
    const { client, close } = await connect(errorBin);
    try {
      const text = firstText(
        await client.readResource({ uri: "suspec://workspace" }),
      );
      const parsed = JSON.parse(text) as { store: unknown; noVerdictIssued: boolean };
      expect(parsed.store).toBeNull();
      expect(parsed.noVerdictIssued).toBe(true);
    } finally {
      await close();
    }
  });
});
