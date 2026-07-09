import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain-JS helper shared with scripts/generate-fixtures.mjs (no .d.ts on purpose)
import { resolveSuspecBin } from "../scripts/resolve-suspec-bin.mjs";

// AC-011 — the fixtures stay GENERATED, not hand-edited. This test re-runs scripts/generate-fixtures.mjs
// against the REAL `suspec` binary into a temp dir, then asserts the checked-in fixtures still match the
// freshly generated ones STRUCTURALLY (every key path identical). It is the wire that trips when a fixture
// is hand-edited or goes stale against the binary — the fixture's job is to be the binary's output, so a
// drift between "what's checked in" and "what the binary now emits" must fail here, loudly.
//
// The comparison normalizes the volatile, environment-specific values the binary stamps — the absolute
// filesystem paths of the temp scratch repo + store (`path` / `spec_path` / `store`) — to a
// placeholder, so the test asserts the SHAPE + the stable values, not the
// machine it ran on. If the suspec binary is not present, the test is skipped (not failed): CI that lacks
// a sibling suspec-cli checkout cannot regenerate, and a false red there would be noise — but the skip is
// LOUD (a stderr warning names what was looked for), so a disarmed tripwire is visible, never silent.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const generator = join(repoRoot, "scripts", "generate-fixtures.mjs");
const suspecBin = resolveSuspecBin(repoRoot);
const checkedInDir = join(here, "fixtures");

const FIXTURES = [
  "write-spec",
  "new-task",
  "status",
  "store-list",
  "check-store",
  "check-file",
  "show-checks",
  "review-report",
];

// Replace the environment-specific values with a stable placeholder so the structural compare is about
// SHAPE + stable content, not the absolute temp scratch path the generator ran in. In the v2 store
// shapes, every absolute path travels under a known key (`path` / `spec_path` / `store`).
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "path" || k === "spec_path" || k === "store") {
        out[k] = "<volatile>";
      } else {
        out[k] = normalize(v);
      }
    }
    return out;
  }
  return value;
}

const suspecPresent = suspecBin !== null;
if (!suspecPresent) {
  // eslint-disable-next-line no-console — a silently disarmed tripwire is worse than noise
  console.warn(
    "[generated-fixtures] SKIPPING the AC-011 drift tripwire: no suspec binary found " +
      "(looked for SUSPEC_BIN and sibling checkouts whose package name is suspec-cli). " +
      "Fixtures can go stale undetected until this suite runs somewhere the binary exists.",
  );
}

describe.skipIf(!suspecPresent)(
  "the contract fixtures stay generated from the real binary (AC-011)",
  () => {
    it("regenerating into a temp dir reproduces the checked-in fixtures (structurally)", () => {
      const tmp = mkdtempSync(join(tmpdir(), "suspec-mcp-genfix-"));
      try {
        const res = spawnSync(
          process.execPath,
          [generator, "--out", tmp, "--suspec-bin", suspecBin],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        expect(
          res.status,
          `generator failed: ${res.stderr ?? ""}`,
        ).toBe(0);

        for (const name of FIXTURES) {
          const fresh = normalize(
            JSON.parse(readFileSync(join(tmp, `${name}.json`), "utf8")),
          );
          const checkedIn = normalize(
            JSON.parse(readFileSync(join(checkedInDir, `${name}.json`), "utf8")),
          );
          expect(
            checkedIn,
            `${name}.json is stale — re-run \`node scripts/generate-fixtures.mjs\``,
          ).toEqual(fresh);
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      // Spawns the real suspec binary to regenerate 8 fixtures; legitimately
      // exceeds the 5s default under the parallel coverage run. Not a race — a
      // genuinely slow subprocess, so a longer per-test timeout is the right fix.
    }, 60_000);
  },
);
