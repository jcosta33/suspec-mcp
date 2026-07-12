import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain-JS helper shared with scripts/generate-fixtures.mjs (no .d.ts on purpose)
import { resolveSuspecBin } from "../scripts/resolve-suspec-bin.mjs";

// The fixtures stay GENERATED, not hand-edited. This test re-runs scripts/generate-fixtures.mjs
// against the REAL `suspec` binary into a temp dir, then asserts the checked-in fixtures still match
// the freshly generated ones exactly. It is the wire that trips when a fixture is hand-edited or goes
// stale against the binary — the fixture's job is to be the binary's output, so a drift between
// "what's checked in" and "what the binary now emits" must fail here, loudly.
//
// The generator passes every artifact path RELATIVE with cwd=scratch, so the captured output carries
// no machine-specific value and the compare needs no normalization. The real binary is a required
// test dependency: skipping when it is absent would let contract drift pass undetected.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const generator = join(repoRoot, "scripts", "generate-fixtures.mjs");
const suspecBin = resolveSuspecBin(repoRoot);
const checkedInDir = join(here, "fixtures");

const FIXTURES = [
  "check-spec",
  "check-review",
  "check-review-diagnostics",
  "check-review-task-mismatch",
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

describe("the contract fixtures stay generated from the real binary", () => {
  it("regenerating into a temp dir reproduces the checked-in fixtures", () => {
    expect(
      suspecBin,
      "fixture drift requires SUSPEC_BIN or a sibling checkout whose package name is suspec-cli",
    ).not.toBeNull();
    if (suspecBin === null) return;

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
});
