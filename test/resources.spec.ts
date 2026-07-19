import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { create_server } from "../src/server.ts";
import { SUPPORTED_CONTRACT_VERSION } from "../src/suspec/contract.ts";

// Exercises the resource surface — ONE fixed URI, the checks contract — over the in-memory
// transport, against the stub. STUB_LOG records every subprocess argv.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const stubBin = join(fixtures, "stub-suspec.mjs");
const errorBin = join(fixtures, "error-after-contract-suspec.mjs");
const nonjsonBin = join(fixtures, "nonjson-after-contract-suspec.mjs");
const oldContractBin = join(fixtures, "old-contract-suspec.mjs");
const contractExitAfterProbeBin = join(
  fixtures,
  "contract-exit-after-probe-suspec.mjs",
);
const malformedContracts = [
  ["empty-contract-suspec.mjs", /missing check ID C001/],
  ["partial-contract-suspec.mjs", /missing check ID C028/],
  ["duplicate-contract-suspec.mjs", /duplicate check ID C001/],
  ["unknown-contract-suspec.mjs", /unknown check ID C999/],
  ["corrupted-contract-suspec.mjs", /must be named unique-ids/],
  ["corrupted-severity-contract-suspec.mjs", /must have severity hard-error/],
] as const;

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
  const server = await create_server({ env: { bin, cwd: root } });
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

describe("suspec-mcp resources", () => {
  it("lists exactly the checks-contract resource and no templated resource", async () => {
    const { client, close } = await connect();
    try {
      const fixed = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(fixed).toEqual(["suspec://checks"]);
      const templates = (await client.listResourceTemplates())
        .resourceTemplates;
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
      expect(parsed.version).toBe("0.23.0");
      expect(parsed.checks.length).toBeGreaterThan(0);
      expect(invocations()).toEqual([
        ["check", "--contract", "--json"],
        ["check", "--contract", "--json"],
      ]);
    } finally {
      await close();
    }
  });

  it("throws when the checks resource invocation returns a structured CLI error", async () => {
    const { client, close } = await connect(errorBin);
    try {
      await expect(
        client.readResource({ uri: "suspec://checks" }),
      ).rejects.toThrow(/simulated structured error/);
    } finally {
      await close();
    }
  });

  it("throws when the checks resource invocation has a launch failure", async () => {
    const { client, close } = await connect(nonjsonBin);
    try {
      await expect(
        client.readResource({ uri: "suspec://checks" }),
      ).rejects.toThrow(/no parseable JSON/);
    } finally {
      await close();
    }
  });

  it("rejects a valid contract payload when the checks resource receives exit 1", async () => {
    const { client, close } = await connect(contractExitAfterProbeBin);
    try {
      await expect(
        client.readResource({ uri: "suspec://checks" }),
      ).rejects.toThrow(/contracts require exit 0/i);
    } finally {
      await close();
    }
  });

  it("refuses startup when the CLI contract version is not exactly supported", async () => {
    await expect(
      create_server({ env: { bin: oldContractBin, cwd: root } }),
    ).rejects.toThrow(
      new RegExp(`checks contract ${SUPPORTED_CONTRACT_VERSION.replaceAll(".", "\\.")}`),
    );
  });

  it.each(malformedContracts)(
    "refuses startup when the exact checks table is malformed: %s",
    async (name, structuralError) => {
      await expect(
        create_server({ env: { bin: join(fixtures, name), cwd: root } }),
      ).rejects.toThrow(
        new RegExp(
          `checks contract ${SUPPORTED_CONTRACT_VERSION.replaceAll(".", "\\.")}.*${structuralError.source}`,
        ),
      );
    },
  );
});
