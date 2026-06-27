import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// AC-011 — the fixtures stay GENERATED, not hand-edited. This test re-runs scripts/generate-fixtures.mjs
// against the REAL `corpus` binary into a temp dir, then asserts the checked-in fixtures still match the
// freshly generated ones STRUCTURALLY (every key path identical). It is the wire that trips when a fixture
// is hand-edited or goes stale against the binary — the fixture's job is to be the binary's output, so a
// drift between "what's checked in" and "what the binary now emits" must fail here, loudly.
//
// The comparison normalizes the two volatile, environment-specific values the binary stamps — absolute
// filesystem paths (the temp workspace) and the review's content-addressed evidenceDigest (a hash of the
// generated diff/packet) — to a placeholder, so the test asserts the SHAPE + the stable values, not the
// machine it ran on. If the corpus binary is not present, the test is skipped (not failed): CI that lacks
// a sibling corpus-cli checkout cannot regenerate, and a false red there would be noise.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const generator = join(repoRoot, "scripts", "generate-fixtures.mjs");
const corpusBin = resolve(repoRoot, "..", "corpus-cli", "bin", "corpus.js");
const checkedInDir = join(here, "fixtures");

const FIXTURES = [
  "new-spec",
  "new-task",
  "promote",
  "status",
  "check-workspace",
  "check-file",
  "show-checks",
  "show-spec",
  "show-task",
  "review-report",
  "show-review",
];

// Replace the two environment-specific values with a stable placeholder so the structural compare is about
// SHAPE + stable content, not the absolute temp path or the content hash of a freshly generated diff.
function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    // an absolute path anywhere in the tree (the temp workspace root) → a placeholder.
    return value.replace(/\/[^\s"]*?\/(?:specs|tasks|reviews|findings|\.worktrees)\//g, "/<root>/$1/").replace(
      /^\/.*$/,
      (m) => (m.includes("/") && /\.(md|ts|txt)$/.test(m) ? "<path>" : m),
    );
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // hashes / digests are content-addressed over the generated diff → not stable across runs.
      if (k === "evidenceDigest" || k === "path" || k === "worktreePath") {
        out[k] = "<volatile>";
      } else {
        out[k] = normalize(v);
      }
    }
    return out;
  }
  return value;
}

const corpusPresent = existsSync(corpusBin);

describe.skipIf(!corpusPresent)(
  "the contract fixtures stay generated from the real binary (AC-011)",
  () => {
    it("regenerating into a temp dir reproduces the checked-in fixtures (structurally)", () => {
      const tmp = mkdtempSync(join(tmpdir(), "corpus-mcp-genfix-"));
      try {
        const res = spawnSync(
          process.execPath,
          [generator, "--out", tmp, "--corpus-bin", corpusBin],
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
    });
  },
);
