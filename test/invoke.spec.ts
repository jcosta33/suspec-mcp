import { describe, it, expect } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { invoke_suspec, type SuspecEnv } from "../src/suspec/invoke.ts";

// Direct unit tests for THE subprocess edge — the security/robustness boundary. These cover the
// fact branches (ok / structured-error) plus every failure path (bad verb, bad flag, missing binary,
// non-JSON and empty output) so the boundary is the best-tested file, not the least.
const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "fixtures", "stub-suspec.mjs");
const nonjson = join(here, "fixtures", "nonjson-suspec.mjs");
const delayed = join(here, "fixtures", "delayed-suspec.mjs");
const ignoreTerm = join(here, "fixtures", "ignore-term-suspec.mjs");

const env = (bin: string): SuspecEnv => ({ bin, cwd: here });

// A scratch root carrying the artifacts the stub reads (it sniffs the checked file's
// frontmatter like the real CLI).
function scratchEnv(bin: string): { env: SuspecEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "suspec-mcp-invoke-"));
  writeFileSync(join(dir, "spec.md"), "---\ntype: spec\nid: SPEC-x\n---\n");
  writeFileSync(
    join(dir, "review.md"),
    "---\ntype: review\nid: REVIEW-x\ntask: TASK-x\n---\n",
  );
  writeFileSync(
    join(dir, "task.md"),
    "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-x\nscope: [AC-001]\n---\n",
  );
  return {
    env: { bin, cwd: dir },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("invoke_suspec — the subprocess edge", () => {
  it("refuses a non-allow-listed verb (defense-in-depth programming guard)", () => {
    expect(() => invoke_suspec(env(stub), "rm", ["-rf", "/"])).toThrow(
      /non-allow-listed/,
    );
  });

  it("refuses every verb the CLI does not have (check is the whole surface)", () => {
    for (const verb of [
      "status",
      "store",
      "show",
      "review",
      "new",
      "write",
      "work",
      "done",
      "evidence",
      "promote",
    ]) {
      expect(() => invoke_suspec(env(stub), verb), verb).toThrow(
        /non-allow-listed/,
      );
    }
  });

  it("always appends --json and never a mutation-shaped flag", async () => {
    const s = scratchEnv(stub);
    try {
      const r = await invoke_suspec(s.env, "check", ["spec.md"]);
      expect(r.invocation.command).toMatch(/--json$/);
      expect(r.invocation.command).not.toMatch(
        /--write|--force|--agent|--launch/,
      );
    } finally {
      s.cleanup();
    }
  });

  it('returns kind:"ok" with the parsed data on a check success (and relays the warnings exit code)', async () => {
    const s = scratchEnv(stub);
    try {
      const r = await invoke_suspec(s.env, "check", ["spec.md"]);
      expect(r.kind).toBe("ok");
      expect(r.invocation.exitCode).toBe(1); // a warning report still parses as ok — the exit is a fact
      if (r.kind === "ok") {
        expect(
          (r.data as { diagnostics: unknown[] }).diagnostics.length,
        ).toBeGreaterThan(0);
      }
    } finally {
      s.cleanup();
    }
  });

  it("passes the allow-listed companion flags (--spec/--task) through to check", async () => {
    const s = scratchEnv(stub);
    try {
      const r = await invoke_suspec(s.env, "check", ["review.md"], {
        flags: { "--spec": "spec.md", "--task": "task.md" },
      });
      expect(r.kind).toBe("ok");
      expect(r.invocation.command).toBe(
        `${stub} check review.md --spec spec.md --task task.md --json`,
      );
    } finally {
      s.cleanup();
    }
  });

  it("passes the bare --contract flag through (the contract dump invocation)", async () => {
    const r = await invoke_suspec(env(stub), "check", [], {
      bare: ["--contract"],
    });
    expect(r.kind).toBe("ok");
    expect(r.invocation.command).toBe(`${stub} check --contract --json`);
    if (r.kind === "ok") {
      expect((r.data as { version: string }).version).toBeTruthy();
    }
  });

  it("refuses a non-allow-listed VALUED flag (a slip that tried --from or --write would throw)", () => {
    for (const flag of ["--write", "--launch", "--from", "--scope", "--base"]) {
      expect(() =>
        invoke_suspec(env(stub), "check", ["spec.md"], {
          flags: { [flag]: "x" },
        }),
      ).toThrow(/non-allow-listed flag/);
    }
  });

  it("refuses a non-allow-listed BARE flag (only --contract passes)", () => {
    for (const flag of ["--staleness", "--force", "--json"]) {
      expect(() =>
        invoke_suspec(env(stub), "check", [], { bare: [flag] }),
      ).toThrow(/non-allow-listed flag/);
    }
  });

  it("records the configured binary and unambiguous spaced argv in provenance", async () => {
    const s = scratchEnv(stub);
    try {
      const spacedBin = join(s.env.cwd, "stub suspec.mjs");
      copyFileSync(stub, spacedBin);
      chmodSync(spacedBin, 0o755);
      writeFileSync(
        join(s.env.cwd, "review path.md"),
        "---\ntype: review\nid: REVIEW-x\ntask: TASK-x\n---\n",
      );
      writeFileSync(
        join(s.env.cwd, "spec path.md"),
        "---\ntype: spec\nid: SPEC-x\n---\n",
      );
      writeFileSync(
        join(s.env.cwd, "task path.md"),
        "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-x\nscope: [AC-001]\n---\n",
      );
      const r = await invoke_suspec(
        { ...s.env, bin: spacedBin },
        "check",
        ["review path.md"],
        { flags: { "--spec": "spec path.md", "--task": "task path.md" } },
      );
      expect(r.invocation.command).toBe(
        `'${spacedBin}' check 'review path.md' --spec 'spec path.md' --task 'task path.md' --json`,
      );
    } finally {
      s.cleanup();
    }
  });

  it("does not block the event loop while a CLI subprocess is slow", async () => {
    const started = Date.now();
    let timerElapsed = Number.POSITIVE_INFINITY;
    setTimeout(() => {
      timerElapsed = Date.now() - started;
    }, 25);

    const slow = Promise.resolve(
      invoke_suspec(env(delayed), "check", ["slow"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(timerElapsed).toBeLessThan(150);

    const fast = await invoke_suspec(env(delayed), "check", ["fast"]);
    expect(fast.kind).toBe("ok");
    expect((await slow).kind).toBe("ok");
  });

  it("force-kills a timed-out CLI even when it ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await invoke_suspec(
      { bin: ignoreTerm, cwd: here, timeoutMs: 100 },
      "check",
      ["slow"],
    );
    expect(Date.now() - started).toBeLessThan(300);
    expect(result.kind).toBe("launch-error");
  });

  it('returns kind:"structured-error" when the CLI emits an error object (exit 2)', async () => {
    const s = scratchEnv(stub);
    try {
      // the conditional-companion refusal: the review names a task, no --task handed
      const r = await invoke_suspec(s.env, "check", ["review.md"], {
        flags: { "--spec": "spec.md" },
      });
      expect(r.kind).toBe("structured-error");
      expect(r.invocation.exitCode).toBe(2);
      if (r.kind === "structured-error") {
        expect(r.error.error).toBe("Usage");
        expect(r.error.message).toMatch(/missing --task/);
      }
    } finally {
      s.cleanup();
    }
  });

  it('returns kind:"launch-error" when the binary cannot be launched', async () => {
    const r = await invoke_suspec(
      env("/nonexistent/suspec-does-not-exist"),
      "check",
      ["x.md"],
    );
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/could not launch/);
    }
  });

  it('returns kind:"launch-error" with the stderr tail when output is non-JSON', async () => {
    const r = await invoke_suspec(env(nonjson), "check", ["garbage"]);
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/no parseable JSON/);
      expect(r.message).toMatch(/boom/); // the stderr tail is surfaced
    }
  });

  it('returns kind:"launch-error" when the CLI produces empty output', async () => {
    const r = await invoke_suspec(env(nonjson), "check", ["empty"]);
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/no parseable JSON/);
    }
  });

  it("catches a synchronous execFile throw (NUL-byte arg) and returns a clean launch-error, never escapes", async () => {
    // execFile throws synchronously on a NUL byte. The input guards reject it upstream, but the
    // try/catch is defense-in-depth — a throw must still become a launch-error, not propagate.
    // (\x00 escape, not a raw byte: a raw NUL renders as whitespace and hides what this tests.)
    const r = await invoke_suspec(env(stub), "check", ["bad\x00path.md"]);
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/could not run/);
    }
  });
});
