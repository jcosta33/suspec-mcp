// Root-confinement for a shell-out adapter. Three untrusted inputs reach the CLI: a file PATH (for
// check_file), a run/spec/AC SLUG (for review / new task), and a free-text INTENT line (for `write
// spec`). All are validated here before any subprocess runs, so a malicious client cannot make
// `suspec` read outside the repo, inject a flag, or break the spawn.

import { resolve, isAbsolute, relative, dirname } from "node:path";
import { realpathSync, existsSync } from "node:fs";

// True if the string contains any ASCII control character (NUL … US). A NUL byte throws inside
// spawnSync; control chars are never part of a valid workspace path / ref. (Checked by code point so
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

// Validate a client-supplied path resolves INSIDE the workspace root; return it workspace-RELATIVE
// (safe to pass to a `suspec` invoked with cwd=root), or null if it escapes. Rejects: control chars (a
// NUL byte breaks spawn), `..` traversal, absolute escapes, the root itself (not a file), flag-shaped
// paths, and symlink escapes — including a symlinked PARENT directory even when the leaf does not exist
// yet (so the guard is correct for the loader and safe-write verbs, not only the read verb whose
// file-not-found would otherwise backstop it).
export function confine_path(root: string, candidate: string): string | null {
  if (has_control_char(candidate)) {
    return null;
  }
  const rootReal = resolve_root(root);
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(rootReal, candidate);
  // Canonicalize the deepest EXISTING ancestor through any symlinks, then re-anchor the (possibly
  // not-yet-existing) leaf onto it BEFORE the inside-root check. This is correct even when the root or
  // an ancestor is itself reached via a symlink (macOS /tmp, or ~/code -> /data/code): an absolute
  // in-workspace path is canonicalized rather than lexically rejected for its symlinked prefix (#27).
  // It still rejects a symlinked ancestor or leaf that points OUTSIDE the root.
  let existing = resolved;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  const realExisting = existsSync(existing) ? realpathSync(existing) : existing;
  const tail = relative(existing, resolved); // '' when the full path already exists
  const canonical = tail === "" ? realExisting : resolve(realExisting, tail);
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

// A run slug / spec id / AC id is interpolated by the CLI into `run-<slug>.md` etc. in the store — it
// must be a single safe path segment, never a separator or traversal token.
export function is_safe_segment(segment: string): boolean {
  // Reject separators, traversal, and a leading `-` (a flag-shaped stem like `--help` would be parsed
  // by the CLI as an option, not the task to review).
  return (
    /^[A-Za-z0-9._-]+$/.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith("-")
  );
}

// The one-line intent `suspec write spec` scaffolds from. Free text by design (the CLI slugs it
// itself), so the guard is minimal but real: non-empty, bounded (the CLI caps the slug; a multi-KB
// blob is abuse, not an intent), no control characters (a NUL breaks spawn; newlines are never part
// of a one-liner), and not flag-shaped (a leading `-` would be parsed by the CLI as an option).
export function is_safe_intent(intent: string): boolean {
  if (intent.length === 0 || intent.length > 300 || intent.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < intent.length; i += 1) {
    if (intent.charCodeAt(i) < 0x20) {
      return false;
    }
  }
  return true;
}
