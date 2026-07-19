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
import { require_supported_contract } from "../src/suspec/compatibility.ts";
import {
  SUPPORTED_CHECKS,
  SUPPORTED_CONTRACT_VERSION,
} from "../src/suspec/contract.ts";

// Direct unit tests for THE subprocess edge — the security/robustness boundary. These cover the
// fact branches (ok / structured-error) plus every failure path (bad verb, bad flag, missing binary,
// non-JSON and empty output) so the boundary is the best-tested file, not the least.
const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "fixtures", "stub-suspec.mjs");
const nonjson = join(here, "fixtures", "nonjson-suspec.mjs");
const delayed = join(here, "fixtures", "delayed-suspec.mjs");
const ignoreTerm = join(here, "fixtures", "ignore-term-suspec.mjs");
const invalidPayload = join(here, "fixtures", "invalid-payload-suspec.mjs");

const env = (bin: string): SuspecEnv => ({ bin, cwd: here });
const checkOptions = (
  flags?: Readonly<Record<string, string>>,
): Parameters<typeof invoke_suspec>[3] => ({
  ...(flags === undefined ? {} : { flags }),
  expected: "reports",
});
const contractOptions: Parameters<typeof invoke_suspec>[3] = {
  bare: ["--contract"],
  expected: "contract",
};

function fixedOutputBin(
  data: unknown,
  exitCode: number,
  output: "json" | "jsonl" = "json",
): {
  bin: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "suspec-mcp-fixed-output-"));
  const bin = join(dir, "suspec.mjs");
  const stdout =
    output === "jsonl"
      ? (data as unknown[]).map((document) => JSON.stringify(document)).join("\n")
      : JSON.stringify(data);
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${String(exitCode)});\n`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function reportForLevel(level: "clean" | "warning" | "blocking", path: string) {
  const diagnostics =
    level === "clean"
      ? []
      : [
          {
            code: level === "warning" ? "C008" : "C021",
            severity: level === "warning" ? "warning" : "hard-error",
            message: "demo",
            line: null,
          },
        ];
  return { type: "spec", level, path, diagnostics };
}

function fileSetReport() {
  return {
    path: "(file set)",
    level: "blocking",
    diagnostics: [
      {
        code: "C002",
        severity: "hard-error",
        message: "duplicate id",
        line: null,
      },
    ],
  };
}

// A scratch root carrying the artifacts the stub reads (it sniffs the checked file's
// frontmatter like the real CLI).
function scratchEnv(bin: string): { env: SuspecEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "suspec-mcp-invoke-"));
  writeFileSync(join(dir, "spec.md"), "---\ntype: spec\nid: SPEC-x\n---\n");
  writeFileSync(
    join(dir, "review.md"),
    "---\ntype: review\nid: REVIEW-x\nspec: SPEC-x\ntask: TASK-x\nreviewer: fixture-reviewer\n---\n",
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
    expect(() => invoke_suspec(env(stub), "rm", ["-rf", "/"], checkOptions())).toThrow(
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
      expect(() => invoke_suspec(env(stub), verb, [], checkOptions()), verb).toThrow(
        /non-allow-listed/,
      );
    }
  });

  it("always appends --json and never a mutation-shaped flag", async () => {
    const s = scratchEnv(stub);
    try {
      const r = await invoke_suspec(s.env, "check", ["spec.md"], checkOptions());
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
      const r = await invoke_suspec(s.env, "check", ["spec.md"], checkOptions());
      expect(r.kind).toBe("ok");
      expect(r.invocation.exitCode).toBe(1); // a warning report still parses as ok — the exit is a fact
      if (r.kind === "ok") {
        expect(
          (r.data as { diagnostics: unknown[] }[])[0].diagnostics.length,
        ).toBeGreaterThan(0);
      }
    } finally {
      s.cleanup();
    }
  });

  it("passes the allow-listed companion flags (--spec/--task) through to check", async () => {
    const s = scratchEnv(stub);
    try {
      const r = await invoke_suspec(
        s.env,
        "check",
        ["review.md"],
        checkOptions({ "--spec": "spec.md", "--task": "task.md" }),
      );
      expect(r.kind).toBe("ok");
      expect(r.invocation.command).toBe(
        `${stub} check review.md --spec spec.md --task task.md --json`,
      );
    } finally {
      s.cleanup();
    }
  });

  it("passes the bare --contract flag through (the contract dump invocation)", async () => {
    const r = await invoke_suspec(env(stub), "check", [], contractOptions);
    expect(r.kind).toBe("ok");
    expect(r.invocation.command).toBe(`${stub} check --contract --json`);
    if (r.kind === "ok") {
      expect((r.data as { version: string }).version).toBeTruthy();
    }
  });

  it("refuses a non-allow-listed VALUED flag (a slip that tried --from or --write would throw)", () => {
    for (const flag of ["--write", "--launch", "--from", "--scope", "--base"]) {
      expect(() =>
        invoke_suspec(
          env(stub),
          "check",
          ["spec.md"],
          checkOptions({ [flag]: "x" }),
        ),
      ).toThrow(/non-allow-listed flag/);
    }
  });

  it("refuses a non-allow-listed BARE flag (only --contract passes)", () => {
    for (const flag of ["--staleness", "--force", "--json"]) {
      expect(() =>
        invoke_suspec(env(stub), "check", [], {
          bare: [flag],
          expected: "contract",
        }),
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
        "---\ntype: review\nid: REVIEW-x\nspec: SPEC-x\ntask: TASK-x\nreviewer: fixture-reviewer\n---\n",
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
        checkOptions({
          "--spec": "spec path.md",
          "--task": "task path.md",
        }),
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
      invoke_suspec(env(delayed), "check", ["slow"], checkOptions()),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(timerElapsed).toBeLessThan(150);

    const fast = await invoke_suspec(
      env(delayed),
      "check",
      ["fast"],
      checkOptions(),
    );
    expect(fast.kind).toBe("ok");
    expect((await slow).kind).toBe("ok");
  });

  it("force-kills a timed-out CLI even when it ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await invoke_suspec(
      { bin: ignoreTerm, cwd: here, timeoutMs: 100 },
      "check",
      ["slow"],
      checkOptions(),
    );
    expect(Date.now() - started).toBeLessThan(300);
    expect(result.kind).toBe("launch-error");
  });

  it('returns kind:"structured-error" when the CLI emits an error object (exit 2)', async () => {
    const s = scratchEnv(stub);
    try {
      // the conditional-companion refusal: the review names a task, no --task handed
      const r = await invoke_suspec(
        s.env,
        "check",
        ["review.md"],
        checkOptions({ "--spec": "spec.md" }),
      );
      expect(r.kind).toBe("structured-error");
      expect(r.invocation.exitCode).toBe(2);
      if (r.kind === "structured-error") {
        const error = (r.data as { error: string; message: string }[])[0];
        expect(error.error).toBe("Usage");
        expect(error.message).toMatch(/missing --task/);
      }
    } finally {
      s.cleanup();
    }
  });

  it.each([0, 1])(
    'returns kind:"launch-error" for a structured error document at exit %i',
    async (exitCode) => {
      const child = fixedOutputBin(
        { error: "Usage", message: "valid-looking structured error" },
        exitCode,
      );
      try {
        const result = await invoke_suspec(
          env(child.bin),
          "check",
          ["spec.md"],
          checkOptions(),
        );
        expect(result.kind).toBe("launch-error");
        if (result.kind === "launch-error") {
          expect(result.message).toMatch(/structured error.*exit 2/i);
        }
      } finally {
        child.cleanup();
      }
    },
  );

  it.each([
    ["clean", 1],
    ["clean", 2],
    ["warning", 0],
    ["warning", 2],
    ["blocking", 0],
    ["blocking", 1],
  ] as const)(
    "rejects a %s-only report stream at exit %i",
    async (level, exitCode) => {
      const child = fixedOutputBin(
        [reportForLevel(level, "spec.md")],
        exitCode,
        "jsonl",
      );
      try {
        const result = await invoke_suspec(
          env(child.bin),
          "check",
          ["spec.md"],
          checkOptions(),
        );
        expect(result.kind).toBe("launch-error");
        if (result.kind === "launch-error") {
          expect(result.message).toContain(`${level} report stream`);
          expect(result.message).toContain(`exit ${exitCode}`);
          expect(result.message).toMatch(/reports require exit [012]/);
        }
      } finally {
        child.cleanup();
      }
    },
  );

  it("uses the maximum report level to validate a report-only JSONL stream", async () => {
    const child = fixedOutputBin(
      [
        reportForLevel("clean", "clean.md"),
        reportForLevel("warning", "warning.md"),
      ],
      1,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["clean.md", "warning.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("ok");
      expect(result.invocation.exitCode).toBe(1);
    } finally {
      child.cleanup();
    }
  });

  it.each([
    [
      "reordered",
      [reportForLevel("clean", "second.md"), reportForLevel("clean", "first.md")],
    ],
    ["missing", [reportForLevel("clean", "first.md")]],
    [
      "substituted",
      [reportForLevel("clean", "first.md"), reportForLevel("clean", "other.md")],
    ],
  ] as const)("rejects a %s primary report stream", async (_name, reports) => {
    const child = fixedOutputBin(reports, 0, "jsonl");
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["first.md", "second.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/ordered primary path/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a file-set report anywhere except one final position", async () => {
    const child = fixedOutputBin(
      [
        fileSetReport(),
        reportForLevel("clean", "first.md"),
        reportForLevel("clean", "second.md"),
      ],
      2,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["first.md", "second.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/ordered primary path/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a mixed report/structured-error JSONL stream", async () => {
    const child = fixedOutputBin(
      [
        reportForLevel("blocking", "spec.md"),
        { error: "Usage", message: "mixed stream" },
      ],
      2,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["spec.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/mixed report.*structured error/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects multiple structured-error documents", async () => {
    const child = fixedOutputBin(
      [
        { error: "Usage", message: "first" },
        { error: "Usage", message: "second" },
      ],
      2,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["spec.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/2 structured errors.*exactly one/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects one document that matches both report and structured-error schemas", async () => {
    const child = fixedOutputBin(
      {
        ...reportForLevel("blocking", "spec.md"),
        error: "Usage",
        message: "ambiguous payload",
      },
      2,
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["spec.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/matches both.*schemas/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a report that also claims to be unchecked", async () => {
    const child = fixedOutputBin(
      {
        ...reportForLevel("blocking", "audit.md"),
        type: "audit",
        checked: false,
      },
      2,
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["audit.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/violates the supported contract/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a checked-clean report for a recognized unchecked type", async () => {
    const child = fixedOutputBin(
      { ...reportForLevel("clean", "audit.md"), type: "audit" },
      0,
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["audit.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/violates the supported contract/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a final file-set report whose diagnostics are not exclusively C002", async () => {
    const child = fixedOutputBin(
      [
        reportForLevel("clean", "first.md"),
        reportForLevel("clean", "second.md"),
        {
          path: "(file set)",
          level: "blocking",
          diagnostics: [
            {
              code: "C021",
              severity: "hard-error",
              message: "wrong diagnostic",
              line: null,
            },
          ],
        },
      ],
      2,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["first.md", "second.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/violates the supported contract/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a typed final file-set report", async () => {
    const child = fixedOutputBin(
      [
        reportForLevel("clean", "first.md"),
        reportForLevel("clean", "second.md"),
        {
          type: "spec",
          path: "(file set)",
          level: "blocking",
          diagnostics: [
            {
              code: "C002",
              severity: "hard-error",
              message: "duplicate id",
              line: null,
            },
          ],
        },
      ],
      2,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["first.md", "second.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/file-set|supported contract/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a report with an unknown level", async () => {
    const child = fixedOutputBin(
      [{ type: "spec", level: "unknown", path: "spec.md", diagnostics: [] }],
      0,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["spec.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/violates the supported contract/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it("rejects a diagnostic whose severity contradicts the supported checks table", async () => {
    const child = fixedOutputBin(
      [
        {
          type: "spec",
          level: "warning",
          path: "spec.md",
          diagnostics: [
            {
              code: "C021",
              severity: "warning",
              message: "intent missing",
              line: null,
            },
          ],
        },
      ],
      1,
      "jsonl",
    );
    try {
      const result = await invoke_suspec(
        env(child.bin),
        "check",
        ["spec.md"],
        checkOptions(),
      );
      expect(result.kind).toBe("launch-error");
      if (result.kind === "launch-error") {
        expect(result.message).toMatch(/diagnostic C021 must have severity hard-error/i);
      }
    } finally {
      child.cleanup();
    }
  });

  it.each([3, 126, 127])(
    'returns kind:"launch-error" for unsupported exit %i even with valid-looking JSON',
    async (exitCode) => {
      const child = fixedOutputBin(
        { type: "spec", level: "clean", path: "spec.md", diagnostics: [] },
        exitCode,
      );
      try {
        const result = await invoke_suspec(
          env(child.bin),
          "check",
          ["spec.md"],
          checkOptions(),
        );
        expect(result.kind).toBe("launch-error");
        expect(result.invocation.exitCode).toBe(exitCode);
        if (result.kind === "launch-error") {
          expect(result.message).toMatch(/unsupported exit code/);
        }
      } finally {
        child.cleanup();
      }
    },
  );

  it('returns kind:"launch-error" when the binary cannot be launched', async () => {
    const r = await invoke_suspec(
      env("/nonexistent/suspec-does-not-exist"),
      "check",
      ["x.md"],
      checkOptions(),
    );
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/could not launch/);
    }
  });

  it('returns kind:"launch-error" with the stderr tail for an unsupported child exit', async () => {
    const r = await invoke_suspec(
      env(nonjson),
      "check",
      ["garbage"],
      checkOptions(),
    );
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/unsupported exit code 3/);
      expect(r.message).toMatch(/boom/); // the stderr tail is surfaced
    }
  });

  it('returns kind:"launch-error" when the CLI produces empty output', async () => {
    const r = await invoke_suspec(
      env(nonjson),
      "check",
      ["empty"],
      checkOptions(),
    );
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/no parseable JSON/);
    }
  });

  it("catches a synchronous execFile throw (NUL-byte arg) and returns a clean launch-error, never escapes", async () => {
    // execFile throws synchronously on a NUL byte. The input guards reject it upstream, but the
    // try/catch is defense-in-depth — a throw must still become a launch-error, not propagate.
    // (\x00 escape, not a raw byte: a raw NUL renders as whitespace and hides what this tests.)
    const r = await invoke_suspec(
      env(stub),
      "check",
      ["bad\x00path.md"],
      checkOptions(),
    );
    expect(r.kind).toBe("launch-error");
    if (r.kind === "launch-error") {
      expect(r.message).toMatch(/could not run/);
    }
  });

  it("rejects the whole JSONL stream when any document violates the runtime schema", async () => {
    const result = await invoke_suspec(
      env(invalidPayload),
      "check",
      ["/first.md", "/second.md"],
      checkOptions(),
    );
    expect(result.kind).toBe("launch-error");
    if (result.kind === "launch-error") {
      expect(result.message).toMatch(/violates the supported contract/);
    }
  });
});

describe("checks-contract compatibility probe", () => {
  it.each([1, 2])("rejects a valid contract payload at exit %i", async (exitCode) => {
    const child = fixedOutputBin(
      { version: SUPPORTED_CONTRACT_VERSION, checks: SUPPORTED_CHECKS },
      exitCode,
    );
    try {
      await expect(require_supported_contract(env(child.bin))).rejects.toThrow(
        new RegExp(`checks contract ${SUPPORTED_CONTRACT_VERSION.replaceAll(".", "\\.")}.*exit 0`, "i"),
      );
    } finally {
      child.cleanup();
    }
  });
});
