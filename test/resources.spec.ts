import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { create_server } from "../src/server.ts";

// Exercises the resource surface (fixed + templated) over the in-memory transport, against the stub.
// STUB_LOG records every subprocess argv, so the "no subprocess on a rejected id" claim is provable.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const stubBin = join(fixtures, "stub-corpus.mjs");
const errorBin = join(fixtures, "error-corpus.mjs"); // always emits a structured CLI error
const nonjsonBin = join(fixtures, "nonjson-corpus.mjs"); // emits non-JSON → launch-error

let root: string;
let logPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corpus-mcp-res-"));
  mkdirSync(join(root, "findings"), { recursive: true });
  writeFileSync(
    join(root, "findings", "lesson.md"),
    "# Finding\n\nA durable lesson.",
  );
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

// Symmetric to the tool sweep (server.spec INV-002): no resource body may carry a corpus-mcp-AUTHORED
// verdict key. Resources serve the CLI's data verbatim (only `workspace` wraps it, adding
// noVerdictIssued) — none routes the `corpus check` verdict field — so no forbidden key should appear.
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

describe("corpus-mcp resources", () => {
  it("lists fixed resources + templated resources", async () => {
    const { client, close } = await connect();
    try {
      const fixed = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(fixed).toEqual([
        "corpus://checks",
        "corpus://status",
        "corpus://workspace",
      ]);
      const templates = (await client.listResourceTemplates()).resourceTemplates
        .map((r) => r.uriTemplate)
        .sort();
      expect(templates).toEqual([
        "corpus://findings/{id}",
        "corpus://reviews/{id}",
        "corpus://specs/{id}",
        "corpus://tasks/{id}",
      ]);
    } finally {
      await close();
    }
  });

  it("no resource body carries a corpus-mcp-authored verdict key (INV-002, symmetric to the tool sweep)", async () => {
    const { client, close } = await connect();
    try {
      const uris = [
        "corpus://workspace",
        "corpus://status",
        "corpus://checks",
        "corpus://tasks/feat",
        "corpus://specs/SPEC-feat",
        "corpus://reviews/feat",
        "corpus://findings/lesson",
      ];
      for (const uri of uris) {
        const text = firstText(await client.readResource({ uri }));
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          continue; // findings are raw markdown, not JSON — no authored object to scan
        }
        const keys = collect_keys(parsed);
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
      expect(
        firstText(await client.readResource({ uri: "corpus://workspace" })),
      ).toContain('"mode": "read-only"');
      expect(
        firstText(await client.readResource({ uri: "corpus://status" })),
      ).toContain('"level"');
      expect(
        firstText(await client.readResource({ uri: "corpus://checks" })),
      ).toContain('"version"');
    } finally {
      await close();
    }
  });

  it("reads the templated artifact resources (task / spec / review / finding)", async () => {
    const { client, close } = await connect();
    try {
      expect(
        firstText(await client.readResource({ uri: "corpus://tasks/feat" })),
      ).toContain("TASK-feat");
      expect(
        firstText(
          await client.readResource({ uri: "corpus://specs/SPEC-feat" }),
        ),
      ).toContain("SPEC-feat");
      expect(
        firstText(await client.readResource({ uri: "corpus://reviews/feat" })),
      ).toContain("needs-human");
      // findings have no parser — served as raw markdown from disk, root-confined
      expect(
        firstText(
          await client.readResource({ uri: "corpus://findings/lesson" }),
        ),
      ).toContain("A durable lesson");
    } finally {
      await close();
    }
  });

  it("rejects a flag-shaped id on every validated template with a labelled error and NO subprocess", async () => {
    const { client, close } = await connect();
    try {
      for (const uri of [
        "corpus://tasks/--help",
        "corpus://reviews/--help",
        "corpus://specs/--help",
        "corpus://findings/--help",
      ]) {
        expect(firstText(await client.readResource({ uri }))).toMatch(
          /"error": ?"InvalidId"/,
        );
      }
      // The id was rejected BEFORE any `corpus show` subprocess ran (not after, on a non-zero exit).
      expect(invocations()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("renders a structured CLI error as the resource body (body_of structured-error branch)", async () => {
    const { client, close } = await connect(errorBin);
    try {
      const text = firstText(
        await client.readResource({ uri: "corpus://status" }),
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
        await client.readResource({ uri: "corpus://status" }),
      );
      expect(text).toMatch(/"error": ?"adapter"/);
      expect(text).toMatch(/no parseable JSON/);
    } finally {
      await close();
    }
  });

  it("a missing finding reads as a labelled placeholder; a traversal-shaped id is rejected, never read", async () => {
    const { client, close } = await connect();
    try {
      // A well-formed but absent id resolves to the labelled placeholder (existsSync false arm).
      expect(
        firstText(
          await client.readResource({
            uri: "corpus://findings/does-not-exist",
          }),
        ),
      ).toMatch(/no finding/i);
      // A traversal-shaped id (`%2f`, `..`) fails is_safe_segment → InvalidId, with no file read at
      // all — so it cannot escape the root and cannot read /etc/passwd's contents.
      const rejected = firstText(
        await client.readResource({
          uri: "corpus://findings/..%2f..%2fetc%2fpasswd",
        }),
      );
      expect(rejected).toMatch(/"error": ?"InvalidId"/);
      expect(rejected).not.toMatch(/root:.*:0:0:/);
    } finally {
      await close();
    }
  });
});
