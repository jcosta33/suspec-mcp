import { describe, it, expect } from "vitest";

import { parse_config } from "../src/index.ts";

describe("parse_config", () => {
  it("defaults to cwd + `corpus` on PATH", () => {
    const c = parse_config([], {}, "/ws");
    expect(c.bin).toBe("corpus");
    expect(c.root).toContain("ws");
  });

  it("reads workspace + bin from the environment", () => {
    const c = parse_config(
      [],
      { CORPUS_WORKSPACE: "/env-ws", CORPUS_BIN: "/bin/corpus" },
      "/cwd",
    );
    expect(c.bin).toBe("/bin/corpus");
    expect(c.root).toContain("env-ws");
  });

  it("lets flags override the environment", () => {
    const c = parse_config(
      ["--workspace", "/flag-ws", "--corpus-bin", "/flag-bin"],
      { CORPUS_WORKSPACE: "/env-ws" },
      "/cwd",
    );
    expect(c.bin).toBe("/flag-bin");
    expect(c.root).toContain("flag-ws");
  });

  it("treats a flag-shaped value as missing (does not consume --corpus-bin as the workspace)", () => {
    const c = parse_config(["--workspace", "--corpus-bin", "/b"], {}, "/cwd");
    expect(c.bin).toBe("/b"); // --corpus-bin was NOT swallowed as the --workspace value
    expect(c.root).toContain("cwd"); // --workspace got no value → stays the cwd default
  });
});
