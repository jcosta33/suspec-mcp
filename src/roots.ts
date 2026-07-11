// Root-confinement for a shell-out adapter. The untrusted inputs that reach the CLI are file PATHS
// (the checked artifact and a review's `spec`/`task` companions). All are validated here before any
// subprocess runs, so a malicious client cannot make `suspec` read outside the workspace, inject a
// flag, or break the spawn.

import { resolve, isAbsolute, relative, dirname } from "node:path";
import { realpathSync, existsSync, lstatSync, readlinkSync } from "node:fs";

// True if the string contains any ASCII control character (NUL … US). A NUL byte throws inside
// spawnSync; control chars are never part of a valid workspace path. (Checked by code point so
// the source carries no literal control bytes.)
function has_control_char(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      return true;
    }
  }
  return false;
}

// Resolve the workspace root to a canonical absolute path (following any symlink on the root itself).
export function resolve_root(root: string): string {
  return existsSync(root) ? realpathSync(root) : resolve(root);
}

// True if a filesystem entry exists AT this path without following a final symlink — so a DANGLING
// symlink (one whose target is missing) counts as present. existsSync would report it absent, since
// it follows the link to the missing target and cannot distinguish it from a bare not-yet-created path.
function path_exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Canonicalize an absolute path that may end in not-yet-existing components, resolving EVERY symlink
// through to its real target — including a dangling symlink, which existsSync/realpathSync silently
// walk past, leaving its true (possibly out-of-root) target uninspected. Any purely-lexical trailing
// components are anchored onto the canonicalized existing prefix. Throws on a symlink cycle (hop budget).
function canonicalize(target: string, hops = 0): string {
  if (hops > 40) {
    throw new Error("too many symbolic links");
  }
  // Deepest ancestor that has a filesystem entry — a dangling symlink counts (lstat, not stat). An
  // absolute path always bottoms out at "/", which exists, so this ancestor is guaranteed to exist.
  let existing = target;
  while (!path_exists(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  const tail = relative(existing, target); // '' when the whole path has an entry
  let realExisting: string;
  if (lstatSync(existing).isSymbolicLink()) {
    // Resolve one hop against the link's own (existing) parent dir, then canonicalize the target so
    // its REAL location — not the link — is what the lexical tail is anchored onto.
    const link = readlinkSync(existing);
    const hop = isAbsolute(link)
      ? resolve(link)
      : resolve(realpathSync(dirname(existing)), link);
    realExisting = canonicalize(hop, hops + 1);
  } else {
    realExisting = realpathSync(existing); // real file/dir (symlinks above it resolved too)
  }
  return tail === "" ? realExisting : resolve(realExisting, tail);
}

// Validate a client-supplied path resolves INSIDE the workspace root; return it workspace-RELATIVE
// (safe to pass to a `suspec` invoked with cwd=root), or null if it escapes. Rejects: control chars (a
// NUL byte breaks spawn), `..` traversal, absolute escapes, the root itself (not a file), flag-shaped
// paths, and symlink escapes — including a symlinked PARENT directory even when the leaf does not exist
// yet.
export function confine_path(root: string, candidate: string): string | null {
  if (has_control_char(candidate)) {
    return null;
  }
  const rootReal = resolve_root(root);
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(rootReal, candidate);
  // Canonicalize the whole path — resolving every symlink component, including a DANGLING one — then
  // re-anchor the (possibly not-yet-existing) leaf onto it BEFORE the inside-root check. This is correct
  // even when the root or an ancestor is itself reached via a symlink (macOS /tmp, or ~/code ->
  // /data/code): an absolute in-workspace path is canonicalized rather than lexically rejected for its
  // symlinked prefix (#27). It still rejects a symlinked ancestor or leaf that points OUTSIDE the root,
  // whether or not that link's target exists yet. Any resolution failure (e.g. a symlink cycle) is fatal.
  let canonical: string;
  try {
    canonical = canonicalize(resolved);
  } catch {
    return null;
  }
  const finalRel = relative(rootReal, canonical);
  if (finalRel.startsWith("..") || isAbsolute(finalRel)) {
    return null; // resolves outside root (a `..`/absolute escape or a symlink pointing out)
  }
  return inside_root(finalRel) ? finalRel : null;
}

// A workspace-relative path is safe to hand the CLI iff it stays inside root AND is not flag-shaped: a
// path whose FIRST character is `-` would be parsed by the CLI as an option, not a positional.
function inside_root(rel: string): boolean {
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !isAbsolute(rel) &&
    !rel.startsWith("-")
  );
}
