// Resolve the real `suspec` CLI binary for fixture generation (AC-011).
//
// A checkout directory need not match its package or remote name. Resolution order:
//   1. SUSPEC_BIN env var (a path to the binary), then
//   2. every sibling directory whose package.json name is "suspec-cli" and that ships bin/suspec.js
//      (folder name irrelevant), preferring `../suspec-cli` when both exist.
// Returns the absolute path, or null when no optional sibling resolves. An explicit path is a
// promise from an integration environment, so a bad one throws instead of disabling the guard.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], { encoding });
}

export function inspectSuspecBin(value) {
  const bin = realpathSync(resolve(value));
  const packageRoot = realpathSync(resolve(dirname(bin), ".."));
  const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath)) {
    throw new Error(
      `suspec fixture binary has no package.json at ${packagePath}`,
    );
  }
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  if (pkg.name !== "suspec-cli") {
    throw new Error(
      `suspec fixture binary must belong to package suspec-cli; received ${pkg.name ?? "no package name"}`,
    );
  }
  const declaredValue = pkg.bin?.suspec;
  if (typeof declaredValue !== "string" || declaredValue.length === 0) {
    throw new Error("suspec-cli package must declare a nonempty bin.suspec path");
  }
  const declaredRequest = resolve(packageRoot, declaredValue);
  const packagePrefix = `${packageRoot}${sep}`;
  if (!declaredRequest.startsWith(packagePrefix) || !existsSync(declaredRequest)) {
    throw new Error(`suspec-cli declared bin.suspec is missing or escapes its package: ${declaredValue}`);
  }
  const declaredBin = realpathSync(declaredRequest);
  if (declaredBin !== bin) {
    throw new Error(
      `suspec fixture binary must be the package's declared suspec binary; declared=${relative(packageRoot, declaredBin)} received=${relative(packageRoot, bin)}`,
    );
  }
  const gitRoot = realpathSync(
    git(packageRoot, ["rev-parse", "--show-toplevel"]).trim(),
  );
  if (gitRoot !== packageRoot) {
    throw new Error(
      `suspec-cli package root must be its git root; package=${packageRoot} git=${gitRoot}`,
    );
  }
  const head = git(packageRoot, ["rev-parse", "HEAD"]).trim();
  const status = git(
    packageRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "buffer",
  );
  const diff = git(packageRoot, ["diff", "--binary", "HEAD"], "buffer");
  const untracked = git(
    packageRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "buffer",
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const worktree = createHash("sha256").update(status).update(diff);
  for (const path of untracked) {
    worktree
      .update(path)
      .update("\0")
      .update(readFileSync(join(packageRoot, path)));
  }
  return {
    packageName: pkg.name,
    packageVersion: pkg.version,
    packageRoot: "git-root",
    binary: relative(packageRoot, bin),
    binarySha256: sha256(readFileSync(bin)),
    gitHead: head,
    worktreeDirty: status.length > 0,
    worktreeSha256: worktree.digest("hex"),
  };
}

export function resolveSuspecBin(repoRoot) {
  const fromEnv = process.env.SUSPEC_BIN;
  if (fromEnv) {
    const resolved = resolve(fromEnv);
    inspectSuspecBin(resolved);
    return resolved;
  }

  const parent = resolve(repoRoot, "..");
  const candidates = [];
  const preferred = join(parent, "suspec-cli");
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(parent, entry.name);
    const bin = join(dir, "bin", "suspec.js");
    const pkg = join(dir, "package.json");
    if (!existsSync(bin) || !existsSync(pkg)) continue;
    try {
      const name = JSON.parse(readFileSync(pkg, "utf8")).name;
      if (name === "suspec-cli") candidates.push(bin);
    } catch {
      // unreadable package.json — not a candidate
    }
  }
  const preferredBin = join(preferred, "bin", "suspec.js");
  if (candidates.includes(preferredBin)) return preferredBin;
  return candidates[0] ?? null;
}
