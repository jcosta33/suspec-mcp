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

import {
  confine_path,
  is_safe_segment,
  is_safe_base,
  task_stem,
} from "../src/roots.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "corpus-mcp-roots-")));
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
      mkdtempSync(join(tmpdir(), "corpus-mcp-link-")),
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
      mkdtempSync(join(tmpdir(), "corpus-mcp-outside-")),
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
      mkdtempSync(join(tmpdir(), "corpus-mcp-outside-")),
    );
    symlinkSync(outside, join(root, "evildir")); // a dir symlink pointing outside root
    try {
      expect(confine_path(root, "evildir/not-yet-created.md")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a path containing a control character (NUL)", () => {
    expect(
      confine_path(root, `specs/a${String.fromCharCode(0)}/x.md`),
    ).toBeNull();
  });
});

describe("is_safe_base", () => {
  it("accepts real git refs (slash, tilde, caret, dot, at, reflog, SHA)", () => {
    for (const ref of [
      "main",
      "origin/main",
      "HEAD~1",
      "HEAD^",
      "v1.2.3",
      "feature/x-y",
      "HEAD@{1}",
      "a1b2c3d4e5",
    ]) {
      expect(is_safe_base(ref), ref).toBe(true);
    }
  });
  it("rejects flag-shaped, empty, and whitespace/control bases", () => {
    expect(is_safe_base("--force")).toBe(false);
    expect(is_safe_base("-x")).toBe(false);
    expect(is_safe_base("")).toBe(false);
    expect(is_safe_base("a b")).toBe(false);
    expect(is_safe_base(`a${String.fromCharCode(0)}b`)).toBe(false);
  });
  it("rejects git transport-option and shell-metacharacter injections (owns the boundary)", () => {
    // `=`/`:` enable `--upload-pack=`/`ext::`; the rest are shell metachars. None is a legal ref char.
    for (const bad of [
      "origin/--upload-pack=x",
      "ext::sh -c id",
      "a=b",
      "a:b",
      "`id`",
      "$(id)",
      "a;b",
      "a|b",
      "a&b",
      "a>b",
      "a*b",
      "a'b",
    ]) {
      expect(is_safe_base(bad), bad).toBe(false);
    }
  });
});

describe("is_safe_segment", () => {
  it("accepts a plain stem", () => {
    expect(is_safe_segment("001-app-setup")).toBe(true);
  });
  it("rejects separators and traversal", () => {
    expect(is_safe_segment("a/b")).toBe(false);
    expect(is_safe_segment("..")).toBe(false);
    expect(is_safe_segment(".")).toBe(false);
    expect(is_safe_segment("a b")).toBe(false);
    expect(is_safe_segment("")).toBe(false);
  });
  it("rejects a flag-shaped stem (leading `-`)", () => {
    expect(is_safe_segment("--help")).toBe(false);
    expect(is_safe_segment("-base")).toBe(false);
  });
});

describe("task_stem", () => {
  it("strips a leading TASK- and lower-cases (mirrors the CLI review_slug)", () => {
    expect(task_stem("TASK-001-App-Setup")).toBe("001-app-setup");
    expect(task_stem("baseline-cleanup")).toBe("baseline-cleanup");
  });
});
