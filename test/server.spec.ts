import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { create_server } from "../src/server.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const stubBin = join(fixtures, "stub-suspec.mjs");
const invalidPayloadBin = join(fixtures, "invalid-payload-suspec.mjs");
const contractExitAfterProbeBin = join(
  fixtures,
  "contract-exit-after-probe-suspec.mjs",
);

let root: string;
let logPath: string;

function artifactPath(path: string): string {
  return join(root, path);
}

function invocations(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function snapshot(dir: string): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else {
        entries.push(
          `${relative(dir, full)}\t${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
        );
      }
    }
  };
  walk(dir);
  return entries.join("\n");
}

async function connectClient(bin = stubBin): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = await create_server({ env: { bin, cwd: root } });
  writeFileSync(logPath, ""); // exclude the startup contract probe from per-tool assertions
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suspec-mcp-server-"));
  for (const dir of ["specs", "reviews", "tasks", "audits"]) {
    mkdirSync(artifactPath(dir), { recursive: true });
  }
  writeFileSync(
    artifactPath("specs/a.md"),
    "---\ntype: spec\nid: SPEC-a\n---\n\n## Intent\n\nA.\n\n## Requirements\n",
  );
  writeFileSync(
    artifactPath("specs/b.md"),
    "---\ntype: spec\nid: SPEC-b\n---\n\n## Intent\n\nB.\n\n## Requirements\n",
  );
  writeFileSync(
    artifactPath("reviews/review.md"),
    "---\ntype: review\nid: REVIEW-a\ntask: TASK-a\n---\n\n## Requirement coverage\n",
  );
  writeFileSync(
    artifactPath("tasks/task.md"),
    "---\ntype: task\nid: TASK-a\nsource: [SPEC-a]\nscope: [AC-001]\n---\n",
  );
  writeFileSync(
    artifactPath("audits/audit.md"),
    "---\ntype: audit\nid: AUDIT-a\n---\n",
  );
  logPath = `${root}.log`;
  process.env.STUB_LOG = logPath;
});

afterEach(() => {
  delete process.env.STUB_LOG;
  rmSync(root, { recursive: true, force: true });
  rmSync(logPath, { force: true });
});

describe("suspec-mcp server", () => {
  it("exposes only the multi-path check tool, checks tool, and checks resource", async () => {
    const { client, close } = await connectClient();
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "suspec_check",
        "suspec_get_checks",
      ]);
      expect((await client.listResources()).resources.map((item) => item.uri)).toEqual([
        "suspec://checks",
      ]);
      await expect(client.listPrompts()).rejects.toThrow(/Method not found|-32601/);
    } finally {
      await close();
    }
  });

  it("returns only the lean envelope fields", async () => {
    const { client, close } = await connectClient();
    try {
      for (const call of [
        {
          name: "suspec_check",
          arguments: { paths: [artifactPath("specs/a.md")] },
        },
        { name: "suspec_get_checks", arguments: {} },
      ]) {
        const result = (await client.callTool(call)) as {
          structuredContent: Record<string, unknown>;
        };
        expect(Object.keys(result.structuredContent).sort()).toEqual([
          "data",
          "ok",
          "responseFormat",
          "source",
        ]);
      }
    } finally {
      await close();
    }
  });

  it("checks every primary path in order through one CLI invocation", async () => {
    const paths = [artifactPath("specs/b.md"), artifactPath("specs/a.md")];
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: { paths, responseFormat: "detailed" },
      })) as {
        structuredContent: {
          ok: boolean;
          data: { path: string; diagnostics: unknown[] }[];
          source: { exitCode: number };
        };
      };
      expect(result.structuredContent.ok).toBe(true);
      expect(result.structuredContent.source.exitCode).toBe(1);
      expect(result.structuredContent.data.map((item) => item.path)).toEqual(paths);
      expect(invocations()).toEqual([["check", ...paths, "--json"]]);
    } finally {
      await close();
    }
  });

  it("surfaces the cross-file C002 report after the ordered primary reports", async () => {
    writeFileSync(
      artifactPath("specs/b.md"),
      "---\ntype: spec\nid: SPEC-a\n---\n\n## Intent\n\nB.\n\n## Requirements\n",
    );
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: {
          paths: [artifactPath("specs/a.md"), artifactPath("specs/b.md")],
          responseFormat: "detailed",
        },
      })) as {
        structuredContent: {
          data: { path: string; diagnostics: { code: string }[] }[];
          source: { exitCode: number };
        };
      };
      expect(result.structuredContent.data.map((item) => item.path)).toEqual([
        artifactPath("specs/a.md"),
        artifactPath("specs/b.md"),
        "(file set)",
      ]);
      expect(result.structuredContent.data[2].diagnostics[0].code).toBe("C002");
      expect(result.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("passes companions only for a single primary review target", async () => {
    const review = artifactPath("reviews/review.md");
    const specPath = artifactPath("specs/a.md");
    const taskPath = artifactPath("tasks/task.md");
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [review], specPath, taskPath },
      })) as { structuredContent: { ok: boolean; data: { level: string }[] } };
      expect(result.structuredContent.ok).toBe(true);
      expect(result.structuredContent.data[0].level).toBe("clean");
      expect(invocations()).toEqual([
        ["check", review, "--spec", specPath, "--task", taskPath, "--json"],
      ]);

      const alias = artifactPath("reviews/review-alias.md");
      symlinkSync(review, alias);
      const deduplicated = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [review, review, alias], specPath, taskPath },
      })) as { structuredContent: { ok: boolean; data: { level: string }[] } };
      expect(deduplicated.structuredContent.ok).toBe(true);
      expect(deduplicated.structuredContent.data).toHaveLength(1);

      const ambiguous = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [review, artifactPath("specs/b.md")], specPath },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content[0].text).toMatch(/exactly one review target/);
      expect(invocations()).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("keeps structured CLI errors in data without duplicating their message", async () => {
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: {
          paths: [artifactPath("reviews/review.md")],
          specPath: artifactPath("specs/a.md"),
        },
      })) as {
        isError?: boolean;
        structuredContent: {
          ok: boolean;
          data: { error: string; message: string }[];
          note?: string;
          source: { exitCode: number };
        };
      };
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.ok).toBe(false);
      expect(result.structuredContent.data[0].message).toMatch(/missing --task/);
      expect(result.structuredContent.note).toBeUndefined();
      expect(result.structuredContent.source.exitCode).toBe(2);
    } finally {
      await close();
    }
  });

  it("keeps recognized unchecked artifacts explicit in concise output", async () => {
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [artifactPath("audits/audit.md")] },
      })) as { structuredContent: { data: unknown } };
      expect(result.structuredContent.data).toEqual([
        {
          level: "clean",
          path: artifactPath("audits/audit.md"),
          type: "audit",
          checked: false,
        },
      ]);
    } finally {
      await close();
    }
  });

  it("rejects empty, relative, unsafe, and ambiguous companion paths before checking", async () => {
    const { client, close } = await connectClient();
    try {
      const invalid = [
        { paths: [] },
        { paths: ["relative.md"] },
        { paths: [`${artifactPath("specs/a.md")}\u0000`] },
        { paths: [artifactPath("reviews/review.md")], specPath: "relative.md" },
        {
          paths: [artifactPath("reviews/review.md")],
          specPath: artifactPath("specs/a.md"),
          taskPath: `${artifactPath("tasks/task.md")}\u202e`,
        },
      ];
      for (const args of invalid) {
        const result = (await client.callTool({
          name: "suspec_check",
          arguments: args,
        })) as { isError?: boolean };
        expect(result.isError, JSON.stringify(args)).toBe(true);
      }
      expect(invocations()).toEqual([]);
    } finally {
      await close();
    }
  });

  it("passes absolute paths outside the subprocess cwd unchanged", async () => {
    const outside = mkdtempSync(join(tmpdir(), "suspec-mcp-outside-"));
    const path = join(outside, "spec.md");
    writeFileSync(path, "---\ntype: spec\nid: SPEC-outside\n---\n");
    const { client, close } = await connectClient();
    try {
      await client.callTool({ name: "suspec_check", arguments: { paths: [path] } });
      expect(invocations()).toEqual([["check", path, "--json"]]);
    } finally {
      await close();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes nothing and passes no mutation-shaped flag", async () => {
    const { client, close } = await connectClient();
    try {
      const before = snapshot(root);
      await client.callTool({
        name: "suspec_check",
        arguments: { paths: [artifactPath("specs/a.md")] },
      });
      await client.callTool({ name: "suspec_get_checks", arguments: {} });
      expect(snapshot(root)).toBe(before);
      const argv = invocations().flat();
      for (const flag of ["--write", "--force", "--agent", "--launch"]) {
        expect(argv).not.toContain(flag);
      }
    } finally {
      await close();
    }
  });

  it("returns the exact supported checks contract", async () => {
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_get_checks",
        arguments: { responseFormat: "detailed" },
      })) as {
        structuredContent: { data: { version: string }; responseFormat: string };
      };
      expect(result.structuredContent.data.version).toBe("0.18.0");
      expect(result.structuredContent.responseFormat).toBe("detailed");
      expect(invocations()).toEqual([["check", "--contract", "--json"]]);
    } finally {
      await close();
    }
  });

  it("rejects a valid contract payload when suspec_get_checks receives exit 1", async () => {
    const { client, close } = await connectClient(contractExitAfterProbeBin);
    try {
      const result = (await client.callTool({
        name: "suspec_get_checks",
        arguments: {},
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/contracts require exit 0/i);
    } finally {
      await close();
    }
  });

  it("defaults to concise output and retains actionable line anchors", async () => {
    const { client, close } = await connectClient();
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [artifactPath("specs/a.md")] },
      })) as {
        structuredContent: { data: unknown; responseFormat: string };
      };
      expect(result.structuredContent.responseFormat).toBe("concise");
      expect(result.structuredContent.data).toEqual([
        {
          level: "warning",
          path: artifactPath("specs/a.md"),
          diagnostics: [
            { code: "C004", severity: "warning", message: "demo", line: 1 },
          ],
        },
      ]);
    } finally {
      await close();
    }
  });

  it("fails the tool when any CLI JSONL document violates the runtime schema", async () => {
    const { client, close } = await connectClient(invalidPayloadBin);
    try {
      const result = (await client.callTool({
        name: "suspec_check",
        arguments: { paths: [artifactPath("specs/a.md"), artifactPath("specs/b.md")] },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/violates the supported contract/);
    } finally {
      await close();
    }
  });
});
