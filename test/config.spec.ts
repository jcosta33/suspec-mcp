import { describe, it, expect } from "vitest";

import { parse_config } from "../src/index.ts";

describe("parse_config", () => {
  it("defaults to `suspec` on PATH", () => {
    expect(parse_config([], {}).bin).toBe("suspec");
  });

  it("reads the binary from the environment", () => {
    expect(parse_config([], { SUSPEC_BIN: "/bin/suspec" }).bin).toBe(
      "/bin/suspec",
    );
  });

  it("lets the binary flag override the environment", () => {
    expect(
      parse_config(["--suspec-bin", "/flag/bin"], {
        SUSPEC_BIN: "/env/bin",
      }).bin,
    ).toBe("/flag/bin");
  });

  it("accepts the equals form", () => {
    expect(parse_config(["--suspec-bin=/eq/bin"], {}).bin).toBe("/eq/bin");
  });

  it("rejects a missing or empty binary path", () => {
    expect(() => parse_config(["--suspec-bin"], {})).toThrow(
      "--suspec-bin requires a non-empty path",
    );
    expect(() => parse_config(["--suspec-bin="], {})).toThrow(
      "--suspec-bin requires a non-empty path",
    );
    expect(() => parse_config(["--suspec-bin", "--other"], {})).toThrow(
      "--suspec-bin requires a non-empty path",
    );
  });

  it("rejects unknown arguments", () => {
    expect(() => parse_config(["--other"], {})).toThrow(
      "unknown argument: --other",
    );
    expect(() => parse_config(["artifact.md"], {})).toThrow(
      "unknown argument: artifact.md",
    );
  });
});
