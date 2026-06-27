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

// The server is driven over an in-memory transport against a STUB `corpus` binary (deterministic +
// offline). The stub logs every argv to STUB_LOG so we can assert which subprocesses ran (or didn't).
const stubBin = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "stub-corpus.mjs",
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
  root = mkdtempSync(join(tmpdir(), "corpus-mcp-srv-"));
  mkdirSync(join(root, "specs", "a"), { recursive: true });
  writeFileSync(join(root, "specs", "a", "spec.md"), "# spec");
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

// The READ + RECONCILE tier (the read-only sweep). The SAFE-WRITE tier (scaffold_*/split_task) is
// exercised separately — it legitimately writes a scaffold, so it must NOT be in the no-write sweep.
const ALL_TOOL_CALLS = [
  { name: "corpus_get_status", arguments: {} },
  { name: "corpus_list", arguments: { kind: "specs" } },
  { name: "corpus_check_workspace", arguments: {} },
  { name: "corpus_check_file", arguments: { path: "specs/a/spec.md" } },
  { name: "corpus_reconcile", arguments: { task: "feat" } },
  { name: "corpus_get_task", arguments: { task: "feat" } },
  { name: "corpus_get_spec", arguments: { spec: "SPEC-feat" } },
  { name: "corpus_get_review", arguments: { task: "feat" } },
  { name: "corpus_get_checks", arguments: {} },
];

describe("corpus-mcp server", () => {
  it("lists the read + reconcile + safe-write tools and resources", async () => {
    const { client, close } = await connectClient();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(
        [
          // read tier
          "corpus_check_file",
          "corpus_check_workspace",
          "corpus_get_checks",
          "corpus_get_review",
          "corpus_get_spec",
          "corpus_get_status",
          "corpus_get_task",
          "corpus_list",
          // reconcile tier (one tool — AC-007)
          "corpus_reconcile",
          // safe-write tier (AC-009)
          "corpus_scaffold_finding",
          "corpus_scaffold_spec",
          "corpus_split_task",
        ].sort(),
      );
      const resources = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(resources).toEqual([
        "corpus://checks",
        "corpus://status",
        "corpus://workspace",
      ]);
      const prompts = (await client.listPrompts()).prompts
        .map((p) => p.name)
        .sort();
      expect(prompts).toContain("corpus_before_done");
      expect(prompts).toContain("corpus_review_assistant");
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
  });

  it("get_status surfaces the board", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_get_status",
        arguments: {},
      })) as {
        structuredContent: { ok: boolean; data: { specs: unknown[] } };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.specs.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("reconcile on a task with no worktree returns a structured not-runnable result, not an error", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { task: "noworktree" },
      })) as {
        isError?: boolean;
        structuredContent: { ok: boolean; note?: string };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      // The specific not-runnable guidance, not merely the word "worktree" anywhere in the note.
      expect(r.structuredContent.note).toMatch(/no live run to reconcile/i);
      expect(r.structuredContent.note).toMatch(/launch the run first/i);
    } finally {
      await close();
    }
  });

  it("reconcile derives a STRUCTURED human-attention list from the reconcile facts (AC-010)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { task: "feat" },
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
      // structured items (AC-010): the uncovered AC-002 surfaces by ref + category, not a flat string.
      const ac002 = attention.find((a) => a.ref === "AC-002");
      expect(ac002?.category).toBe("coverage");
      expect(ac002?.message).toContain("AC-002");
      expect(["blocking", "warning", "info"]).toContain(ac002?.severity);
    } finally {
      await close();
    }
  });

  it("reconcile accepts a `spec` id for the task-less 1:1 review-to-spec case, passed VERBATIM", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { spec: "SPEC-feat" },
      })) as { isError?: boolean; structuredContent: { ok: boolean } };
      expect(r.isError).toBeFalsy();
      // The CLI receives the spec id VERBATIM — never lowercased/stripped by task_stem (which would
      // turn `SPEC-feat` into `spec-feat` and break resolution).
      const reviewCall = invocations().find((argv) => argv[0] === "review");
      expect(reviewCall).toContain("SPEC-feat");
    } finally {
      await close();
    }
  });

  it("reconcile rejects passing neither task nor spec, and passing both (exactly one)", async () => {
    const { client, close } = await connectClient();
    try {
      const neither = (await client.callTool({
        name: "corpus_reconcile",
        arguments: {},
      })) as { isError?: boolean; content: { text: string }[] };
      expect(neither.isError).toBe(true);
      expect(neither.content[0].text).toMatch(/exactly one of/i);
      const both = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { task: "feat", spec: "SPEC-feat" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(both.isError).toBe(true);
      expect(both.content[0].text).toMatch(/exactly one of/i);
      // An invalid spec id (a separator) is rejected as a spec id — not stemmed, not run.
      const badSpec = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { spec: "a/b" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(badSpec.isError).toBe(true);
      expect(badSpec.content[0].text).toMatch(/invalid spec id/i);
    } finally {
      await close();
    }
  });

  it("rejects a path outside the root with isError and runs NO subprocess", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_check_file",
        arguments: { path: "../../../etc/passwd" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/outside the workspace root/);
      // No `corpus` subprocess was spawned for the rejected path.
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
      expect(snapshot(root)).toBe(before); // belt-and-suspenders: workspace byte-identical after a full sweep
      // The load-bearing, non-circular check: the stub drops a WRITE-FLAG-SEEN marker IFF it ever
      // receives a write/mutation flag. It never appears → the adapter never passed one. (The
      // snapshot above is weaker — the stub itself never writes — so the marker carries the real signal.)
      expect(existsSync(join(root, "WRITE-FLAG-SEEN"))).toBe(false);
      // and no invocation ever carried a mutation flag
      const flags = invocations().flat();
      for (const forbidden of ["--write", "--force", "--agent"]) {
        expect(flags).not.toContain(forbidden);
      }
      // every invocation appended `--json` (the only flag the adapter adds)
      expect(invocations().every((argv) => argv.includes("--json"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("passes a valid --base (with a slash) to the CLI and rejects a flag-shaped base (AC/INV-004)", async () => {
    const { client, close } = await connectClient();
    try {
      // A valid base ref containing `/` reaches the CLI as `--base origin/main` (not silently dropped).
      await client.callTool({
        name: "corpus_reconcile",
        arguments: { task: "feat", base: "origin/main" },
      });
      const reviewCall = invocations().find((a) => a[0] === "review");
      expect(reviewCall).toBeDefined();
      expect(reviewCall).toContain("--base");
      expect(reviewCall).toContain("origin/main");

      // A flag-shaped base is rejected (isError) — never reaches the subprocess as a flag.
      const r = (await client.callTool({
        name: "corpus_reconcile",
        arguments: { task: "feat", base: "--force" },
      })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(invocations().flat()).not.toContain("--force");
    } finally {
      await close();
    }
  });

  it("passes a TASK- prefixed id straight through to `corpus show task` (no pre-strip) — #blind-field-test", async () => {
    const { client, close } = await connectClient();
    try {
      await client.callTool({
        name: "corpus_get_task",
        arguments: { task: "TASK-feat" },
      });
      const showCall = invocations().find(
        (a) => a[0] === "show" && a[1] === "task",
      );
      expect(showCall).toBeDefined();
      // The id reaches the CLI as 'TASK-feat' (un-stripped) — the CLI canonically resolves either
      // form; pre-stripping to the bare 'feat' mismatched the tasks/TASK-feat.md `corpus new task` writes.
      expect(showCall).toContain("TASK-feat");
      expect(showCall).not.toContain("feat");
    } finally {
      await close();
    }
  });

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
  });

  it("every id-taking tool rejects an unsafe id with isError and runs NO subprocess (the input boundary)", async () => {
    const { client, close } = await connectClient();
    try {
      const unsafe = [
        { name: "corpus_reconcile", arguments: { task: "../etc" } },
        { name: "corpus_reconcile", arguments: { spec: "../etc" } },
        { name: "corpus_get_task", arguments: { task: "../etc" } },
        { name: "corpus_get_spec", arguments: { spec: "--help" } },
        { name: "corpus_get_review", arguments: { task: ".." } },
        { name: "corpus_scaffold_spec", arguments: { slug: "../etc" } },
        { name: "corpus_split_task", arguments: { spec: "../etc" } },
        {
          name: "corpus_split_task",
          arguments: { spec: "SPEC-x", scope: ["AC-001", "../etc"] },
        },
        { name: "corpus_scaffold_finding", arguments: { from: "--help" } },
      ];
      for (const call of unsafe) {
        const r = (await client.callTool(call)) as { isError?: boolean };
        expect(r.isError, `${call.name} must reject an unsafe id`).toBe(true);
      }
      expect(invocations(), "no subprocess ran for any rejected id").toEqual(
        [],
      );
    } finally {
      await close();
    }
  });

  it("the loader tools project the parsed artifact (get_task / get_checks)", async () => {
    const { client, close } = await connectClient();
    try {
      const task = (await client.callTool({
        name: "corpus_get_task",
        arguments: { task: "feat" },
      })) as {
        structuredContent: { ok: boolean; data: { value: { id: string } } };
      };
      expect(task.structuredContent.ok).toBe(true);
      expect(task.structuredContent.data.value.id).toBe("TASK-feat");

      const checks = (await client.callTool({
        name: "corpus_get_checks",
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

  // AC-008: validate_review_packet is folded into check_file (it was a thin alias of `corpus check`). A
  // review packet is now checked through the one check_file path.
  it("check_file refuses a path outside the root (isError, no subprocess) — the one check path (AC-008)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_check_file",
        arguments: { path: "../../../etc/passwd" },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/outside the workspace root/);
      expect(invocations()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("check_file surfaces the CLI check diagnostics through the envelope (a review packet checks here too)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_check_file",
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

  // --- AC-012 enumeration ---------------------------------------------------------------------------
  it("corpus_list enumerates specs and tasks from the board (AC-012)", async () => {
    const { client, close } = await connectClient();
    try {
      const specs = (await client.callTool({
        name: "corpus_list",
        arguments: { kind: "specs" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { kind: string; specs: { id: string }[] };
        };
      };
      expect(specs.structuredContent.ok).toBe(true);
      expect(specs.structuredContent.data.kind).toBe("specs");
      expect(specs.structuredContent.data.specs.map((s) => s.id)).toContain(
        "SPEC-x",
      );

      const tasks = (await client.callTool({
        name: "corpus_list",
        arguments: { kind: "tasks" },
      })) as {
        structuredContent: {
          data: { kind: string; tasks: { id: string; spec: string }[] };
        };
      };
      expect(tasks.structuredContent.data.kind).toBe("tasks");
      const taskX = tasks.structuredContent.data.tasks.find(
        (t) => t.id === "TASK-x",
      );
      expect(taskX?.spec).toBe("SPEC-x");
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
          name: "corpus_get_spec",
          arguments: {
            spec: "SPEC-feat",
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
      // Concise is materially smaller — the slice drops the Execution prose, line numbers, frontmatter.
      expect(conciseLen).toBeLessThan(detailedLen);
      // default == concise byte-for-byte (concise is the default)
      expect(len(dflt.structuredContent.data)).toBe(conciseLen);
    } finally {
      await close();
    }
  });

  // --- AC-009 safe-write tier -----------------------------------------------------------------------
  it("the safe-write tier scaffolds artifacts (spec/task/finding) verdict-free, never overwriting (AC-009)", async () => {
    const { client, close } = await connectClient();
    try {
      const spec = (await client.callTool({
        name: "corpus_scaffold_spec",
        arguments: { slug: "new-thing" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          noVerdictIssued: boolean;
          data: { specId: string };
        };
      };
      expect(spec.isError).toBeFalsy();
      expect(spec.structuredContent.noVerdictIssued).toBe(true);
      expect(spec.structuredContent.data.specId).toBe("SPEC-new-thing");
      // the scaffold actually landed on disk (the stub writes it, mirroring the CLI)
      expect(existsSync(join(root, "specs", "new-thing", "spec.md"))).toBe(true);
      // it used `new`, NOT a `--write`/`--force`/`--agent` mutation flag
      const newCall = invocations().find((a) => a[0] === "new");
      expect(newCall).toContain("spec");
      for (const forbidden of ["--write", "--force", "--agent"]) {
        expect(invocations().flat()).not.toContain(forbidden);
      }

      const task = (await client.callTool({
        name: "corpus_split_task",
        arguments: { spec: "SPEC-new-thing", scope: ["AC-001", "AC-002"] },
      })) as {
        isError?: boolean;
        structuredContent: { data: { taskId: string; scope: string[] } };
      };
      expect(task.isError).toBeFalsy();
      expect(task.structuredContent.data.scope).toEqual(["AC-001", "AC-002"]);
      const taskCall = invocations().find((a) => a[0] === "new" && a[1] === "task");
      expect(taskCall).toContain("--from");
      expect(taskCall).toContain("SPEC-new-thing");
      expect(taskCall).toContain("--scope");
      expect(taskCall).toContain("AC-001,AC-002");

      const finding = (await client.callTool({
        name: "corpus_scaffold_finding",
        arguments: { from: "TASK-new-thing" },
      })) as {
        isError?: boolean;
        structuredContent: { data: { slug: string; from: string } };
      };
      expect(finding.isError).toBeFalsy();
      expect(finding.structuredContent.data.from).toBe("TASK-new-thing");
      expect(existsSync(join(root, "findings", "new-thing.md"))).toBe(true);

      // The whole safe-write tier authored NO verdict key anywhere.
      for (const sc of [spec, task, finding]) {
        expect(Object.keys(sc.structuredContent)).not.toContain("verdict");
      }
    } finally {
      await close();
    }
  });

  it("split_task with no scope omits --scope (an unbounded task) and stays verdict-free (AC-009)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "corpus_split_task",
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
