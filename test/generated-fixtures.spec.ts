import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain-JS helper shared with scripts/generate-fixtures.mjs (no .d.ts on purpose)
import { resolveSuspecBin } from "../scripts/resolve-suspec-bin.mjs";
// @ts-expect-error — the fixture generator exports its pure assertion seam without a .d.ts
import { assertCaptureExpectation } from "../scripts/generate-fixtures.mjs";
import { invoke_suspec } from "../src/suspec/invoke.ts";

// The fixtures stay GENERATED, not hand-edited. This test re-runs scripts/generate-fixtures.mjs
// against the REAL `suspec` binary into a temp dir, then asserts the checked-in fixtures still match
// the freshly generated ones exactly. It is the wire that trips when a fixture is hand-edited or goes
// stale against the binary — the fixture's job is to be the binary's output, so a drift between
// "what's checked in" and "what the binary now emits" must fail in an integration snapshot.
//
// The generator passes every artifact path RELATIVE with cwd=scratch, so the captured output carries
// no machine-specific value and the compare needs no normalization. Repository-local runs skip the
// two real-binary tests visibly; the dispatch-only integration gate supplies the CLI and must run them.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const generator = join(repoRoot, "scripts", "generate-fixtures.mjs");
const suspecBin = resolveSuspecBin(repoRoot);
const checkedInDir = join(here, "fixtures");

const FIXTURES = [
  "check-spec",
  "check-task",
  "check-review",
  "check-review-diagnostics",
  "check-review-task-mismatch",
  "check-multiple",
  "check-duplicate-id",
  "check-unchecked",
  "contract",
  "error-missing-task",
  "error-companions-without-review",
  "error-companion-not-found",
  "error-missing-spec",
  "error-task-not-referenced",
  "error-task-wrong-type",
  "error-task-empty-scope",
  "error-task-wrong-source",
  "error-spec-wrong-type",
  "error-review-task-list",
  "error-quoted-bom-missing-spec",
  "provenance",
];

const report = (level: "clean" | "warning" | "blocking", path: string) => ({
  level,
  path,
  diagnostics: [],
});

describe("fixture capture exit assertions", () => {
  it("fails closed when an explicit CLI path does not resolve", () => {
    const original = process.env.SUSPEC_BIN;
    try {
      process.env.SUSPEC_BIN = join(tmpdir(), "missing-suspec-bin");
      expect(() => resolveSuspecBin(repoRoot)).toThrow();
    } finally {
      if (original === undefined) delete process.env.SUSPEC_BIN;
      else process.env.SUSPEC_BIN = original;
    }
  });

  it.each([
    ["json", "clean", 0, JSON.stringify(report("clean", "clean.md"))],
    ["json", "warning", 1, JSON.stringify(report("warning", "warning.md"))],
    ["json", "blocking", 2, JSON.stringify(report("blocking", "blocking.md"))],
    [
      "json",
      "structured-error",
      2,
      JSON.stringify({ error: "Usage", message: "bad input" }),
    ],
    [
      "json",
      "contract",
      0,
      JSON.stringify({ version: "0.19.0", checks: [] }),
    ],
    ["jsonl", "clean", 0, JSON.stringify(report("clean", "clean.md"))],
    [
      "jsonl",
      "warning",
      1,
      [report("clean", "clean.md"), report("warning", "warning.md")]
        .map((document) => JSON.stringify(document))
        .join("\n"),
    ],
    [
      "jsonl",
      "blocking",
      2,
      [report("warning", "warning.md"), report("blocking", "blocking.md")]
        .map((document) => JSON.stringify(document))
        .join("\n"),
    ],
    [
      "jsonl",
      "structured-error",
      2,
      JSON.stringify({ error: "Usage", message: "bad input" }),
    ],
  ] as const)(
    "accepts %s %s captures only at exit %i",
    (format, exitClass, expectedStatus, stdout) => {
      expect(() =>
        assertCaptureExpectation(
          stdout,
          expectedStatus,
          { format, exitClass, expectedStatus },
          "fixture",
        ),
      ).not.toThrow();
    },
  );

  it("aborts when a fixture capture exits with the wrong status", () => {
    expect(() =>
      assertCaptureExpectation(
        JSON.stringify(report("clean", "clean.md")),
        1,
        { format: "json", exitClass: "clean", expectedStatus: 0 },
        "check-spec",
      ),
    ).toThrow(/check-spec expected clean\/exit 0, received exit 1/);
  });

  it("aborts on a mixed or wrongly classified fixture capture", () => {
    const mixed = [
      report("blocking", "blocking.md"),
      { error: "Usage", message: "mixed" },
    ]
      .map((document) => JSON.stringify(document))
      .join("\n");
    expect(() =>
      assertCaptureExpectation(
        mixed,
        2,
        { format: "jsonl", exitClass: "blocking", expectedStatus: 2 },
        "check-mixed",
      ),
    ).toThrow(/mixed\/unknown/);
  });
});

describe("the contract fixtures stay generated from the real binary", () => {
  it.skipIf(suspecBin === null)("regenerating into a temp dir reproduces the checked-in fixtures", () => {
    if (suspecBin === null) throw new Error("integration gate did not supply suspec-cli");

    const tmp = mkdtempSync(join(tmpdir(), "suspec-mcp-genfix-"));
    try {
      const res = spawnSync(
        process.execPath,
        [generator, "--out", tmp, "--suspec-bin", suspecBin],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      expect(res.status, `generator failed: ${res.stderr ?? ""}`).toBe(0);

      for (const name of FIXTURES) {
        const fresh = JSON.parse(
          readFileSync(join(tmp, `${name}.json`), "utf8"),
        );
        const checkedIn = JSON.parse(
          readFileSync(join(checkedInDir, `${name}.json`), "utf8"),
        );
        expect(
          checkedIn,
          `${name}.json is stale — re-run \`node scripts/generate-fixtures.mjs\``,
        ).toEqual(fresh);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    // Spawns the real suspec binary once per captured shape; legitimately exceeds the 5s default
    // under the parallel coverage run. Not a race — a genuinely slow subprocess, so a longer
    // per-test timeout is the right fix.
  }, 60_000);

  it.skipIf(suspecBin === null)("accepts duplicate and symlink-alias paths deduplicated by the real CLI", async () => {
    if (suspecBin === null) throw new Error("integration gate did not supply suspec-cli");

    const tmp = mkdtempSync(join(tmpdir(), "suspec-mcp-alias-"));
    try {
      const specPath = join(tmp, "spec.md");
      const aliasPath = join(tmp, "alias.md");
      writeFileSync(
        specPath,
        "---\ntype: spec\nid: SPEC-alias\nstatus: ready\nsources: [ISSUE-1]\n---\n\n## Intent\n\nCheck alias handling.\n\n## Requirements\n\n### AC-001\nThe tool MUST check one file once.\nVerify with: `true`\n",
      );
      symlinkSync(specPath, aliasPath);

      const result = await invoke_suspec(
        { bin: suspecBin, cwd: tmp },
        "check",
        [specPath, specPath, aliasPath],
        { expected: "reports" },
      );
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.data).toEqual([
          expect.objectContaining({ path: specPath, level: "clean" }),
        ]);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
