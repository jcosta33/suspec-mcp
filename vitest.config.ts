import { defineConfig } from "vitest/config";

// corpus-mcp's gate mirrors corpus-cli's rigor: near-100% coverage, enforced. The thresholds sit a hair
// below the real numbers (statements/lines 99.84, branches 95.73, functions 100 as of the v0 surface) so
// the gate has teeth — a regression that drops a tested path trips it — without being gamed up to a round
// 100. Branches is the tightest (95 vs 95.73, ~one branch of margin) precisely because that is where the
// uncovered code lives; it is NOT a 3-point moat that would let a real tested branch be deleted unnoticed.
//
// The uncovered branches are I/O FALLBACKS, left uncovered deliberately (exercising them would need
// spawn-mocking or a timed signal-kill — coverage theatre, not signal), NOT untested behaviour:
//   • src/corpus/invoke.ts:69  — `caught instanceof Error ? … : String(caught)`: spawnSync throws only
//     Error subclasses, so the String() arm is a belt; the Error arm IS tested (the NUL-byte throw test).
//   • src/corpus/invoke.ts:79,81,90 — `result.status ?? 1` / `result.stdout ?? ''` / `result.stderr ?? ''`:
//     under `encoding: 'utf8'` the streams are always strings and a normally-exiting child carries a
//     numeric status; status is null only on a signal-kill (the 30s timeout), which we do not unit-time.
//   • src/roots.ts:47,54 — the deepest-existing-ancestor realpath arms of confine_path: defensive against
//     a symlinked parent whose realpath differs; the escape cases ARE tested (the symlink-escape tests),
//     these are the inner ternary arms for the non-escaping side.
//   • src/resources.ts confine-null arm — marked `/* v8 ignore */` inline (is_safe_segment already gates).
// All of the security-critical paths (traversal, flag injection, verb allow-list, no-write) ARE covered;
// see test/roots.spec.ts, test/invoke.spec.ts, and test/server.spec.ts.
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
