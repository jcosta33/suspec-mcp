import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confine_path } from "../src/roots.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "suspec-mcp-roots-")));
  mkdirSync(join(root, "specs", "a"), { recursive: true });
  writeFileSync(join(root, "specs", "a", "spec.md"), "# spec");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("confine_path", () => {
  it("accepts a path inside the root and returns it workspace-relative", () => {
    expect(confine_path(root, "specs/a/spec.md")).toBe("specs/a/spec.md");
  });

  it("accepts a not-yet-existing path inside the root (lexical)", () => {
    expect(confine_path(root, "reviews/new.md")).toBe("reviews/new.md");
  });

  it("rejects `..` traversal", () => {
    expect(confine_path(root, "../../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path outside the root", () => {
    expect(confine_path(root, "/etc/passwd")).toBeNull();
  });

  it("rejects the root itself (not a file)", () => {
    expect(confine_path(root, ".")).toBeNull();
  });

  it("rejects a flag-shaped path (leading `-`, which the CLI would parse as an option)", () => {
    expect(confine_path(root, "-rf.md")).toBeNull();
    expect(confine_path(root, "--output")).toBeNull();
  });

  it("accepts an absolute in-workspace path when the workspace root is reached via a symlink (#27)", () => {
    const linkParent = realpathSync(
      mkdtempSync(join(tmpdir(), "suspec-mcp-link-")),
    );
    try {
      const link = join(linkParent, "link");
      symlinkSync(root, link); // link -> the real root
      // confine_path gets the canonical root + an absolute candidate THROUGH the symlink; it must
      // still resolve to the in-workspace file rather than lexically reject the symlinked prefix.
      expect(confine_path(root, join(link, "specs", "a", "spec.md"))).toBe(
        "specs/a/spec.md",
      );
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the root", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "suspec-mcp-outside-")),
    );
    writeFileSync(join(outside, "secret.md"), "x");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    try {
      expect(confine_path(root, "link.md")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked PARENT dir even when the leaf does not exist yet", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "suspec-mcp-outside-")),
    );
    symlinkSync(outside, join(root, "evildir")); // a dir symlink pointing outside root
    try {
      expect(confine_path(root, "evildir/not-yet-created.md")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a DANGLING symlink leaf whose out-of-root target does not exist yet", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "suspec-mcp-outside-")),
    );
    // The target is NOT written first, so the link dangles: existsSync follows it and reports absent,
    // which must not be mistaken for a plain not-yet-created in-root path.
    symlinkSync(join(outside, "secret.md"), join(root, "dangling.md"));
    try {
      expect(confine_path(root, "dangling.md")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a DANGLING symlinked PARENT dir whose out-of-root target does not exist yet", () => {
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "suspec-mcp-outside-")),
    );
    const missingDir = join(outside, "nope"); // never created — the dir symlink dangles
    symlinkSync(missingDir, join(root, "danglingdir"));
    try {
      expect(confine_path(root, "danglingdir/leaf.md")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink cycle instead of looping forever", () => {
    // a -> b -> a: canonicalization can never bottom out, so it must fail closed.
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    expect(confine_path(root, "a")).toBeNull();
  });

  it("accepts an in-root leaf reached through a RELATIVE-target symlink dir", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    mkdirSync(join(root, "sub"), { recursive: true });
    symlinkSync("../real", join(root, "sub", "link")); // relative target, resolves inside root
    // The leaf does not exist yet; the relative link must resolve to real/new.md, not be rejected.
    expect(confine_path(root, "sub/link/new.md")).toBe("real/new.md");
  });

  it("rejects a path containing a control character (NUL)", () => {
    expect(
      confine_path(root, `specs/a${String.fromCharCode(0)}/x.md`),
    ).toBeNull();
  });
});
