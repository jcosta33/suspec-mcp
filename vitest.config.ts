import { defineConfig } from "vitest/config";

// Keep the gate strict without forcing tests to mock Node internals solely to reach defensive
// fallbacks. The remaining uncovered branches in src/suspec/invoke.ts are nullish stream guards and
// the non-Error rejection fallback; execFile's callback supplies strings, and synchronous invocation
// failures are Error instances. The real timeout, launch, malformed-output, path-validation, and
// allow-list boundaries are exercised through public behavior in test/invoke.spec.ts and
// test/server.spec.ts.
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
