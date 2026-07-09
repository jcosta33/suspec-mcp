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
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { create_server } from "../src/server.ts";

// The server is driven over an in-memory transport against a STUB `suspec` binary (deterministic +
// offline). The stub logs every argv to STUB_LOG so we can assert which subprocesses ran (or didn't);
// its safe-write verbs scaffold into STUB_STORE (a stand-in for the user-level store OUTSIDE the repo).
const stubBin = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stub-suspec.mjs",
);

const FORBIDDEN_VERDICT_KEYS = [
  "verdict",
  "pass",
  "fail",
  "merge",
  "decision",
  "approved",
  "mergeAllowed",
];

let root: string;
let store: string;
let logPath: string;

async function connectClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = create_server({ env: { bin: stubBin, cwd: root }, root });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

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

function snapshot(dir: string): string {
  const entries: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else {
        entries.push(
          `${relative(dir, full)}\t${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      }
    }
  };
  walk(dir);
  return entries.sort().join("\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suspec-mcp-srv-"));
  store = mkdtempSync(join(tmpdir(), "suspec-mcp-store-"));
  mkdirSync(join(root, "specs", "a"), { recursive: true });
  writeFileSync(join(root, "specs", "a", "spec.md"), "# spec");
  logPath = `${root}.log`;
  process.env.STUB_LOG = logPath;
  process.env.STUB_STORE = store;
});
afterEach(() => {
  delete process.env.STUB_LOG;
  delete process.env.STUB_STORE;
  rmSync(root, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
  if (existsSync(logPath)) {
    rmSync(logPath);
  }
});

// The READ + RECONCILE tier (the read-only sweep). The SAFE-WRITE tier (scaffold_spec/split_task) is
// exercised separately — it legitimately writes a store scaffold, so it must NOT be in the no-write sweep.
const ALL_TOOL_CALLS = [
  { name: "suspec_get_status", arguments: {} },
  { name: "suspec_list", arguments: {} },
  { name: "suspec_check_store", arguments: {} },
  { name: "suspec_check_file", arguments: { path: "specs/a/spec.md" } },
  { name: "suspec_get_artifact", arguments: { kind: "spec", ref: "SPEC-x" } },
  { name: "suspec_reconcile", arguments: { run: "feat" } },
  { name: "suspec_get_checks", arguments: {} },
];

describe("suspec-mcp server", () => {
  it("lists the v2 read + reconcile + safe-write tools, and NO retired v1 tool", async () => {
    const { client, close } = await connectClient();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(
        [
          // read tier
          "suspec_check_file",
          "suspec_check_store",
          "suspec_get_artifact",
          "suspec_get_checks",
          "suspec_get_status",
          "suspec_list",
          // reconcile tier (one tool)
          "suspec_reconcile",
          // safe-write tier
          "suspec_scaffold_spec",
          "suspec_split_task",
        ].sort(),
      );
      // The retired v1 surface is GONE: the workspace verdict, the per-kind get_* loaders (restored
      // as the single suspec_get_artifact over the store-resolving `show`), and the finding scaffold
      // (promote is a gh-issue mutation now).
      for (const retired of [
        "suspec_check_workspace",
        "suspec_get_task",
        "suspec_get_spec",
        "suspec_get_review",
        "suspec_scaffold_finding",
      ]) {
        expect(tools).not.toContain(retired);
      }
      const resources = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(resources).toEqual([
        "suspec://checks",
        "suspec://status",
        "suspec://workspace",
      ]);
      const prompts = (await client.listPrompts()).prompts
        .map((p) => p.name)
        .sort();
      expect(prompts).toContain("suspec_before_done");
      expect(prompts).toContain("suspec_review_assistant");
    } finally {
      await close();
    }
  });

  it("every tool result carries noVerdictIssued:true and adds no verdict field of its own", async () => {
    const { client, close } = await connectClient();
    try {
      for (const call of ALL_TOOL_CALLS) {
        const result = (await client.callTool(call)) as {
          structuredContent?: Record<string, unknown>;
        };
        const sc = result.structuredContent;
        expect(sc, `${call.name} must return structuredContent`).toBeDefined();
        expect(sc?.noVerdictIssued, `${call.name} noVerdictIssued`).toBe(true);
        for (const key of FORBIDDEN_VERDICT_KEYS) {
          expect(
            Object.keys(sc ?? {}),
            `${call.name} must not add a "${key}" field`,
          ).not.toContain(key);
        }
      }
    } finally {
      await close();
    }
    // A full-sweep test spawns one stub subprocess per tool; legitimately exceeds the 5s default
    // under the parallel coverage run (same rationale as generated-fixtures.spec.ts).
  }, 30_000);

  it("get_status surfaces the store summary (active artifacts + the next ranking)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_get_status",
        arguments: {},
      })) as {
        structuredContent: {
          ok: boolean;
          data: { active: { filename: string }[]; next: unknown[] };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(
        r.structuredContent.data.active.map((a) => a.filename),
      ).toContain("run-feat.md");
      expect(r.structuredContent.data.next.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("suspec_list enumerates the store's artifacts via `store list`", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_list",
        arguments: {},
      })) as {
        structuredContent: {
          ok: boolean;
          data: { store: string; active: { filename: string; kind: string }[] };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(
        r.structuredContent.data.active.map((a) => a.kind),
      ).toContain("run");
      const listCall = invocations().find((a) => a[0] === "store");
      expect(listCall).toContain("list");
    } finally {
      await close();
    }
  });

  it("check_store runs the store lint (`check` with NO file) and slices to the problem artifacts", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_store",
        arguments: {},
      })) as {
        structuredContent: {
          ok: boolean;
          data: { artifacts: { path: string }[] };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      // concise (default) keeps ONLY the artifact carrying a diagnostic
      expect(r.structuredContent.data.artifacts).toHaveLength(1);
      expect(r.structuredContent.data.artifacts[0].path).toContain(
        "run-feat.md",
      );
      // and the CLI face is the bare store lint: `check --json` with no positional
      const checkCall = invocations().find((a) => a[0] === "check");
      expect(checkCall).toEqual(["check", "--json"]);
    } finally {
      await close();
    }
  });

  it("reconcile on a missing run returns a structured no-such-run result, not an error", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_reconcile",
        arguments: { run: "norun" },
      })) as {
        isError?: boolean;
        structuredContent: { ok: boolean; note?: string };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      // The specific runs-appear-after-work guidance, not merely the error message echoed.
      expect(r.structuredContent.note).toMatch(/no such run/i);
      expect(r.structuredContent.note).toMatch(/suspec work/);
    } finally {
      await close();
    }
  });

  it("reconcile derives a STRUCTURED human-attention list from the run-review facts (AC-010)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_reconcile",
        arguments: { run: "feat" },
      })) as {
        structuredContent: {
          derived?: {
            humanAttention: {
              category: string;
              severity: string;
              message: string;
              ref: string | null;
            }[];
          };
        };
      };
      const attention = r.structuredContent.derived?.humanAttention ?? [];
      expect(attention.length).toBeGreaterThan(0);
      // structured items (AC-010): the AC-002 evidence gap surfaces by ref + category, not a flat string.
      const gap = attention.find((a) => a.ref === "AC-002");
      expect(gap?.category).toBe("evidence-gap");
      expect(gap?.message).toContain("AC-002");
      // the hard-error lint diagnostic surfaces as a BLOCKING artifact-lint item on its store path.
      const lint = attention.find((a) => a.category === "artifact-lint");
      expect(lint?.severity).toBe("blocking");
      expect(lint?.ref).toContain("spec-x.md");
    } finally {
      await close();
    }
  });

  it("rejects a path outside the root with isError and runs NO subprocess", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "../../../etc/passwd" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/outside the workspace root/);
      // No `suspec` subprocess was spawned for the rejected path.
      expect(invocations()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("writes nothing durable and never passes a write flag (read-only, reconcile-only)", async () => {
    const { client, close } = await connectClient();
    try {
      const before = snapshot(root);
      for (const call of ALL_TOOL_CALLS) {
        await client.callTool(call);
      }
      expect(snapshot(root)).toBe(before); // belt-and-suspenders: repo byte-identical after a full sweep
      // The load-bearing, non-circular check: the stub drops a WRITE-FLAG-SEEN marker IFF it ever
      // receives a write/mutation/dispatch flag. It never appears → the adapter never passed one. (The
      // snapshot above is weaker — the stub itself never writes to cwd — so the marker carries the signal.)
      expect(existsSync(join(root, "WRITE-FLAG-SEEN"))).toBe(false);
      // and no invocation ever carried a mutation/dispatch flag
      const flags = invocations().flat();
      for (const forbidden of ["--write", "--force", "--agent", "--launch"]) {
        expect(flags).not.toContain(forbidden);
      }
      // every invocation appended `--json` (the only flag the adapter adds)
      expect(invocations().every((argv) => argv.includes("--json"))).toBe(true);
    } finally {
      await close();
    }
    // A full-sweep test spawns one stub subprocess per tool; legitimately exceeds the 5s default
    // under the parallel coverage run (same rationale as generated-fixtures.spec.ts).
  }, 30_000);

  it("no tool adds a verdict key anywhere in its OWN authored content (recursive, INV-002)", async () => {
    const collectKeys = (
      obj: unknown,
      skip: string,
      acc: string[] = [],
    ): string[] => {
      if (Array.isArray(obj)) {
        for (const v of obj) collectKeys(v, skip, acc);
      } else if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          acc.push(k);
          if (k !== skip) collectKeys(v, skip, acc); // `data` is the CLI's verbatim output — exempt
        }
      }
      return acc;
    };
    const { client, close } = await connectClient();
    try {
      for (const call of ALL_TOOL_CALLS) {
        const sc = (
          (await client.callTool(call)) as {
            structuredContent?: Record<string, unknown>;
          }
        ).structuredContent;
        const keys = collectKeys(sc, "data");
        for (const forbidden of FORBIDDEN_VERDICT_KEYS) {
          expect(
            keys,
            `${call.name} adds no nested "${forbidden}"`,
          ).not.toContain(forbidden);
        }
      }
    } finally {
      await close();
    }
    // A full-sweep test spawns one stub subprocess per tool; legitimately exceeds the 5s default
    // under the parallel coverage run (same rationale as generated-fixtures.spec.ts).
  }, 30_000);

  it("every id-taking tool rejects an unsafe input with isError and runs NO subprocess (the input boundary)", async () => {
    const { client, close } = await connectClient();
    try {
      const unsafe = [
        { name: "suspec_reconcile", arguments: { run: "../etc" } },
        { name: "suspec_reconcile", arguments: { run: "--help" } },
        { name: "suspec_get_artifact", arguments: { kind: "spec", ref: "../etc" } },
        { name: "suspec_get_artifact", arguments: { kind: "run", ref: "--help" } },
        { name: "suspec_scaffold_spec", arguments: { intent: "--launch now" } },
        { name: "suspec_scaffold_spec", arguments: { intent: "   " } },
        { name: "suspec_split_task", arguments: { spec: "../etc" } },
        {
          name: "suspec_split_task",
          arguments: { spec: "SPEC-x", scope: ["AC-001", "../etc"] },
        },
      ];
      for (const call of unsafe) {
        const r = (await client.callTool(call)) as { isError?: boolean };
        expect(r.isError, `${call.name} must reject an unsafe input`).toBe(true);
      }
      expect(invocations(), "no subprocess ran for any rejected input").toEqual(
        [],
      );
    } finally {
      await close();
    }
  });

  it("get_artifact loads a store artifact via `show <kind> <ref>` (the restored loader face)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_get_artifact",
        arguments: { kind: "spec", ref: "SPEC-x" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { kind: string; value: { requirements: unknown[] } };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.kind).toBe("spec");
      expect(
        r.structuredContent.data.value.requirements.length,
      ).toBeGreaterThan(0);
      expect(invocations()).toContainEqual(["show", "spec", "SPEC-x", "--json"]);
    } finally {
      await close();
    }
  });

  it("get_artifact on a missing ref surfaces the CLI's structured error as a fact, not a tool error", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_get_artifact",
        arguments: { kind: "finding", ref: "ghost" },
      })) as {
        isError?: boolean;
        structuredContent: { ok: boolean; noVerdictIssued: boolean; note?: string };
      };
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.noVerdictIssued).toBe(true);
      expect(r.structuredContent.note).toMatch(/cannot resolve finding: ghost/);
    } finally {
      await close();
    }
  });

  it("get_checks projects the checks contract", async () => {
    const { client, close } = await connectClient();
    try {
      const checks = (await client.callTool({
        name: "suspec_get_checks",
        arguments: {},
      })) as {
        structuredContent: { data: { value: { checks: unknown[] } } };
      };
      expect(checks.structuredContent.data.value.checks.length).toBeGreaterThan(
        0,
      );
    } finally {
      await close();
    }
  });

  it("check_file surfaces the CLI check diagnostics through the envelope", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/a/spec.md", response_format: "detailed" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { diagnostics: { code: string }[] };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.diagnostics.map((d) => d.code)).toContain(
        "C004",
      );
    } finally {
      await close();
    }
  });

  // --- AC-013 concise/detailed response_format ------------------------------------------------------
  it("a concise read returns materially fewer tokens than detailed, and advertises the format (AC-013)", async () => {
    const { client, close } = await connectClient();
    try {
      const call = (format?: string) =>
        client.callTool({
          name: "suspec_get_status",
          arguments: {
            ...(format ? { response_format: format } : {}),
          },
        }) as Promise<{
          structuredContent: { responseFormat?: string; data: unknown };
        }>;
      const detailed = await call("detailed");
      const concise = await call("concise");
      const dflt = await call(); // default is concise
      expect(detailed.structuredContent.responseFormat).toBe("detailed");
      expect(concise.structuredContent.responseFormat).toBe("concise");
      expect(dflt.structuredContent.responseFormat).toBe("concise");
      const len = (d: unknown) => JSON.stringify(d).length;
      const detailedLen = len(detailed.structuredContent.data);
      const conciseLen = len(concise.structuredContent.data);
      // Concise is materially smaller — the slice drops the archived listing.
      expect(conciseLen).toBeLessThan(detailedLen);
      // default == concise byte-for-byte (concise is the default)
      expect(len(dflt.structuredContent.data)).toBe(conciseLen);
    } finally {
      await close();
    }
  });

  // --- the safe-write tier ---------------------------------------------------------------------------
  it("the safe-write tier scaffolds STORE artifacts (spec from intent / task slice) verdict-free", async () => {
    const { client, close } = await connectClient();
    try {
      const before = snapshot(root);
      const spec = (await client.callTool({
        name: "suspec_scaffold_spec",
        arguments: { intent: "add   dark mode\tto settings" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          noVerdictIssued: boolean;
          data: { spec: string; spec_path: string; launched: boolean };
        };
      };
      expect(spec.isError).toBeFalsy();
      expect(spec.structuredContent.noVerdictIssued).toBe(true);
      expect(spec.structuredContent.data.spec).toBe(
        "SPEC-add-dark-mode-to-settings",
      );
      expect(spec.structuredContent.data.launched).toBe(false);
      // the scaffold landed in the STORE (outside the repo), and the repo stayed byte-identical
      expect(
        existsSync(join(store, "spec-add-dark-mode-to-settings.md")),
      ).toBe(true);
      expect(snapshot(root)).toBe(before);
      // it used `write spec` with the WHITESPACE-NORMALIZED intent as ONE positional, and no
      // mutation/dispatch flag
      const writeCall = invocations().find((a) => a[0] === "write");
      expect(writeCall).toEqual([
        "write",
        "spec",
        "add dark mode to settings",
        "--json",
      ]);

      const task = (await client.callTool({
        name: "suspec_split_task",
        arguments: { spec: "SPEC-new-thing", scope: ["AC-001", "AC-002"] },
      })) as {
        isError?: boolean;
        structuredContent: {
          data: { taskId: string; specId: string; scope: string[] };
        };
      };
      expect(task.isError).toBeFalsy();
      expect(task.structuredContent.data.scope).toEqual(["AC-001", "AC-002"]);
      expect(task.structuredContent.data.specId).toBe("SPEC-new-thing");
      expect(existsSync(join(store, "task-new-thing.md"))).toBe(true);
      const taskCall = invocations().find((a) => a[0] === "new" && a[1] === "task");
      expect(taskCall).toContain("--from");
      expect(taskCall).toContain("SPEC-new-thing");
      expect(taskCall).toContain("--scope");
      expect(taskCall).toContain("AC-001,AC-002");
      for (const forbidden of ["--write", "--force", "--agent", "--launch"]) {
        expect(invocations().flat()).not.toContain(forbidden);
      }

      // The whole safe-write tier authored NO verdict key anywhere.
      for (const sc of [spec, task]) {
        expect(Object.keys(sc.structuredContent)).not.toContain("verdict");
      }
    } finally {
      await close();
    }
  });

  it("split_task with no scope omits --scope (an unbounded task) and stays verdict-free", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_split_task",
        arguments: { spec: "SPEC-x" },
      })) as { isError?: boolean; structuredContent: { noVerdictIssued: boolean } };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.noVerdictIssued).toBe(true);
      const taskCall = invocations().find((a) => a[0] === "new" && a[1] === "task");
      expect(taskCall).toContain("--from");
      expect(taskCall).not.toContain("--scope");
    } finally {
      await close();
    }
  });
});
