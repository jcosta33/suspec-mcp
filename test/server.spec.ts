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
// like the real CLI it reads the checked file's frontmatter, so the companion rules are exercised
// end to end.
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
  mkdirSync(join(root, "specs", "a"), { recursive: true });
  mkdirSync(join(root, "reviews"), { recursive: true });
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(
    join(root, "specs", "a", "spec.md"),
    "---\ntype: spec\nid: SPEC-x\n---\n\n## Requirements\n",
  );
  writeFileSync(
    join(root, "reviews", "review.md"),
    "---\ntype: review\nid: REVIEW-x\ntask: TASK-x\n---\n\n## Requirement coverage\n",
  );
  writeFileSync(
    join(root, "reviews", "review-notask.md"),
    "---\ntype: review\nid: REVIEW-y\n---\n\n## Requirement coverage\n",
  );
  writeFileSync(
    join(root, "tasks", "task.md"),
    "---\ntype: task\nid: TASK-x\nscope: [AC-001]\n---\n",
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

// The whole tool surface — both tools are read-only, so the full sweep doubles as the no-write sweep.
const ALL_TOOL_CALLS = [
  { name: "suspec_check_file", arguments: { path: "specs/a/spec.md" } },
  { name: "suspec_get_checks", arguments: {} },
];

describe("suspec-mcp server", () => {
  it("lists EXACTLY the two check tools, the one contract resource, and no prompts capability", async () => {
    const { client, close } = await connectClient();
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual(["suspec_check_file", "suspec_get_checks"]);
      const resources = (await client.listResources()).resources
        .map((r) => r.uri)
        .sort();
      expect(resources).toEqual(["suspec://checks"]);
      // No prompts are registered, so the server advertises no prompts capability at all.
      await expect(client.listPrompts()).rejects.toThrow(/Method not found|-32601/);
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

  it("check_file surfaces the CLI's diagnostics + exit code through the envelope", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/a/spec.md", response_format: "detailed" },
      })) as {
        structuredContent: {
          ok: boolean;
          source: { exitCode: number };
          data: { diagnostics: { code: string }[] };
        };
      };
      // ok is RUNNABILITY: a warning report ran fine — the findings live in data + the exit code.
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.source.exitCode).toBe(1);
      expect(r.structuredContent.data.diagnostics.map((d) => d.code)).toContain(
        "C004",
      );
      expect(invocations()).toContainEqual([
        "check",
        "specs/a/spec.md",
        "--json",
      ]);
    } finally {
      await close();
    }
  });

  it("check_file hands a review its companions as explicit --spec/--task paths", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: {
          path: "reviews/review.md",
          spec: "specs/a/spec.md",
          task: "tasks/task.md",
        },
      })) as {
        structuredContent: { ok: boolean; data: { level: string } };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.level).toBe("clean");
      expect(invocations()).toContainEqual([
        "check",
        "reviews/review.md",
        "--spec",
        "specs/a/spec.md",
        "--task",
        "tasks/task.md",
        "--json",
      ]);
    } finally {
      await close();
    }
  });

  it("a task-less review checked with only a spec succeeds — the spec-keyed check, no --task in the argv", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: {
          path: "reviews/review-notask.md",
          spec: "specs/a/spec.md",
        },
      })) as {
        structuredContent: { ok: boolean; data: { level: string } };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.level).toBe("clean");
      expect(invocations()).toContainEqual([
        "check",
        "reviews/review-notask.md",
        "--spec",
        "specs/a/spec.md",
        "--json",
      ]);
    } finally {
      await close();
    }
  });

  it("a review checked with NO spec at all → the CLI's missing --spec refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "reviews/review.md" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      // A structured CLI refusal is a FACT for the agent, not a tool error.
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/missing --spec/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a companion handed alongside a NON-review artifact → the CLI's carry-no-review refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/a/spec.md", spec: "specs/a/spec.md" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/carry no review/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a companion path that confines fine but does not exist → the CLI's file-not-found refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: {
          path: "reviews/review.md",
          spec: "specs/a/no-such-spec.md",
          task: "tasks/task.md",
        },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/--spec file not found/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a --task companion that confines fine but does not exist → the CLI's file-not-found refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: {
          path: "reviews/review.md",
          spec: "specs/a/spec.md",
          task: "tasks/no-such-task.md",
        },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/--task file not found/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a PRIMARY path that confines fine but does not exist → the CLI's file-not-found refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/does-not-exist.md" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      // Confinement admits a not-yet-existing lexical path — the CLI's refusal is the backstop.
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/^file not found/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a PRIMARY path that is a directory → the CLI's not-an-artifact-file refusal surfaces as ok:false, not an adapter crash", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(
        /not an artifact file \(it is a directory\)/,
      );
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a review that names a task, checked without one → the CLI's blocking refusal surfaces as ok:false (never silently checking less)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "reviews/review.md", spec: "specs/a/spec.md" },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          note?: string;
          source: { exitCode: number };
        };
      };
      // A structured CLI refusal is a FACT for the agent, not a tool error.
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/missing --task/);
      expect(r.structuredContent.note).toMatch(/TASK-x/);
      expect(r.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("a task handed to a review that references none → the CLI's wiring-mistake refusal surfaces as ok:false", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: {
          path: "reviews/review-notask.md",
          spec: "specs/a/spec.md",
          task: "tasks/task.md",
        },
      })) as {
        isError?: boolean;
        structuredContent: { ok: boolean; note?: string };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.note).toMatch(/companion nothing references/);
    } finally {
      await close();
    }
  });

  it("an artifact type with no check face surfaces the CLI's checked:false notice (concise keeps it whole)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "tasks/task.md" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { level: string; type: string; checked: boolean };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data).toEqual({
        level: "clean",
        type: "task",
        checked: false,
      });
    } finally {
      await close();
    }
  });

  it("rejects a path outside the root with isError and runs NO subprocess — primary AND companions", async () => {
    const { client, close } = await connectClient();
    try {
      const escapes = [
        { path: "../../../etc/passwd" },
        { path: "reviews/review.md", spec: "../../../etc/passwd" },
        {
          path: "reviews/review.md",
          spec: "specs/a/spec.md",
          task: "/etc/passwd",
        },
      ];
      for (const args of escapes) {
        const r = (await client.callTool({
          name: "suspec_check_file",
          arguments: args,
        })) as { isError?: boolean; content: { text: string }[] };
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(r.content[0].text).toMatch(/outside the workspace root/);
      }
      // No `suspec` subprocess was spawned for any rejected path.
      expect(invocations()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("writes nothing durable and never passes a mutation-shaped flag (read-only surface)", async () => {
    const { client, close } = await connectClient();
    try {
      const before = snapshot(root);
      for (const call of ALL_TOOL_CALLS) {
        await client.callTool(call);
      }
      expect(snapshot(root)).toBe(before); // belt-and-suspenders: repo byte-identical after a full sweep
      // The load-bearing, non-circular check: the stub drops a WRITE-FLAG-SEEN marker IFF it ever
      // receives a mutation-shaped flag. It never appears → the adapter never passed one. (The
      // snapshot above is weaker — the stub itself never writes to cwd — so the marker carries the signal.)
      expect(existsSync(join(root, "WRITE-FLAG-SEEN"))).toBe(false);
      const flags = invocations().flat();
      for (const forbidden of ["--write", "--force", "--agent", "--launch"]) {
        expect(flags).not.toContain(forbidden);
      }
      // every invocation is a `check` and appends `--json` (the only flag the adapter adds)
      expect(invocations().every((argv) => argv[0] === "check")).toBe(true);
      expect(invocations().every((argv) => argv.includes("--json"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("get_checks returns the checks contract through the envelope (`check --contract`)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_get_checks",
        arguments: { response_format: "detailed" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { version: string; checks: { id: string; name?: string }[] };
        };
      };
      expect(r.structuredContent.ok).toBe(true);
      expect(r.structuredContent.data.version).toBe("0.16.0");
      expect(r.structuredContent.data.checks.length).toBeGreaterThan(0);
      expect(invocations()).toContainEqual(["check", "--contract", "--json"]);
    } finally {
      await close();
    }
  });

  // --- concise/detailed response_format ---------------------------------------------------------------
  it("a concise read returns materially fewer tokens than detailed, and advertises the format", async () => {
    const { client, close } = await connectClient();
    try {
      const call = (format?: string) =>
        client.callTool({
          name: "suspec_get_checks",
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
      // Concise is materially smaller — the slice drops the human-readable check names.
      expect(conciseLen).toBeLessThan(detailedLen);
      // default == concise byte-for-byte (concise is the default)
      expect(len(dflt.structuredContent.data)).toBe(conciseLen);
    } finally {
      await close();
    }
  });

  it("check_file's concise slice drops the path echo and line anchors end to end (default format)", async () => {
    const { client, close } = await connectClient();
    try {
      const r = (await client.callTool({
        name: "suspec_check_file",
        arguments: { path: "specs/a/spec.md" }, // no response_format → concise
      })) as {
        structuredContent: { responseFormat?: string; data: unknown };
      };
      expect(r.structuredContent.responseFormat).toBe("concise");
      // Exact shape: the slice keeps the outcome + each diagnostic's actionable triple and drops
      // the echoes the stub emits (the report's `path`, the diagnostic's `line: 1`).
      expect(r.structuredContent.data).toEqual({
        level: "warning",
        diagnostics: [{ code: "C004", severity: "warning", message: "demo" }],
      });
    } finally {
      await close();
    }
  });
});
