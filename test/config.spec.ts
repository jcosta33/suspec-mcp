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

  it("accepts the equals form and ignores an empty value", () => {
    expect(parse_config(["--suspec-bin=/eq/bin"], {}).bin).toBe("/eq/bin");
    expect(parse_config(["--suspec-bin="], {}).bin).toBe("suspec");
  });

  it("does not consume a flag-shaped token as the binary value", () => {
    expect(parse_config(["--suspec-bin", "--other"], {}).bin).toBe("suspec");
  });

  it("rejects the retired workspace flag and environment variable", () => {
    expect(() => parse_config(["--workspace", "/repo"], {})).toThrow(
      /full artifact paths/,
    );
    expect(() => parse_config(["--workspace=/repo"], {})).toThrow(
      /full artifact paths/,
    );
    expect(() => parse_config([], { SUSPEC_WORKSPACE: "/repo" })).toThrow(
      /full artifact paths/,
    );
  });
});
