import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — plain-JS helper shared with fixture generation (no .d.ts on purpose)
import {
  inspectSuspecBin,
  resolveSuspecBin,
} from "../scripts/resolve-suspec-bin.mjs";

describe("suspec fixture binary provenance", () => {
  it("rejects an executable from an unrelated package before fixture generation", () => {
    const root = mkdtempSync(join(tmpdir(), "suspec-mcp-wrong-bin-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "not-suspec-cli", version: "1.0.0" }),
      );
      const bin = join(root, "bin", "suspec.js");
      writeFileSync(bin, "#!/usr/bin/env node\n");
      chmodSync(bin, 0o755);
      expect(() => inspectSuspecBin(bin)).toThrow(
        /must belong to package suspec-cli/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unrelated executable inside the suspec-cli package", () => {
    const root = mkdtempSync(
      join(tmpdir(), "suspec-mcp-same-package-wrong-bin-"),
    );
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "suspec-cli",
          version: "1.0.0",
          bin: { suspec: "./bin/suspec.js" },
        }),
      );
      const declaredBin = join(root, "bin", "suspec.js");
      const unrelatedBin = join(root, "bin", "unrelated.js");
      writeFileSync(declaredBin, "#!/usr/bin/env node\n");
      writeFileSync(unrelatedBin, "#!/usr/bin/env node\n");
      chmodSync(declaredBin, 0o755);
      chmodSync(unrelatedBin, 0o755);
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Suspec Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: root },
      );

      expect(() => inspectSuspecBin(unrelatedBin)).toThrow(
        /must be the package's declared suspec binary/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not scan arbitrary siblings from a packaged MCP copy", () => {
    const parent = mkdtempSync(join(tmpdir(), "suspec-mcp-resolver-"));
    const original = process.env.SUSPEC_BIN;
    try {
      delete process.env.SUSPEC_BIN;
      const repoRoot = join(parent, "mcp");
      const lookalike = join(parent, "lookalike");
      mkdirSync(repoRoot);
      mkdirSync(join(lookalike, "bin"), { recursive: true });
      writeFileSync(
        join(lookalike, "package.json"),
        JSON.stringify({
          name: "suspec-cli",
          version: "1.0.0",
          bin: { suspec: "./bin/suspec.js" },
        }),
      );
      writeFileSync(
        join(lookalike, "bin", "suspec.js"),
        "#!/usr/bin/env node\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: lookalike });
      execFileSync("git", ["add", "."], { cwd: lookalike });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Suspec Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: lookalike },
      );

      expect(resolveSuspecBin(repoRoot)).toBeNull();
      const preferred = join(parent, "suspec-cli");
      renameSync(lookalike, preferred);
      expect(resolveSuspecBin(repoRoot)).toBe(
        join(preferred, "bin", "suspec.js"),
      );
    } finally {
      if (original === undefined) delete process.env.SUSPEC_BIN;
      else process.env.SUSPEC_BIN = original;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
