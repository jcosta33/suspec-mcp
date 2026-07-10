import { defineConfig } from "vitest/config";

// suspec-mcp's gate mirrors suspec-cli's rigor: near-100% coverage, enforced. statements/lines/functions
// sit at 100; branches at ~95.7 (as of the path-explicit check surface). The thresholds (99/95/100/99)
// sit a hair below so the gate has teeth — a regression that drops a tested path trips it — without
// being gamed up to a round 100. Branches is the tightest (95 vs ~95.7) precisely because that is where
// the remaining uncovered code lives; it is NOT a moat that would let a real tested branch be deleted
// unnoticed.
//
// The uncovered branches are I/O FALLBACKS + defensive null-coalesce arms, left uncovered deliberately
// (exercising them would need spawn-mocking or a timed signal-kill — coverage theatre, not signal), NOT
// untested behaviour. Line numbers drift with edits; the SHAPES are:
//   • src/suspec/invoke.ts — `caught instanceof Error ? … : String(caught)` (spawnSync throws only Error
//     subclasses, so the String() arm is a belt; the Error arm IS tested via the NUL-byte throw test), and
//     `result.status ?? 1` / `result.stdout ?? ''` / `result.stderr ?? ''`: under `encoding: 'utf8'` the
//     streams are always strings and a normally-exiting child carries a numeric status; status is null only
//     on a signal-kill (the 30s timeout), which we do not unit-time.
//   • src/slices.ts — the `as_obj(d) ?? {}` arm on a known-object element (the reachable fallback arms —
//     a non-object payload / a null list entry — ARE covered by test/slices.spec.ts).
//   • src/roots.ts — the deepest-existing-ancestor realpath arm of confine_path (defensive against a
//     vanished ancestor; the escape cases ARE tested by the symlink-escape tests).
// All of the security-critical paths (traversal, flag injection, verb + flag allow-lists, companion
// confinement) ARE covered; see test/roots.spec.ts, test/invoke.spec.ts, and test/server.spec.ts.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { statements: 99, branches: 95, functions: 100, lines: 99 },
    },
  },
});
