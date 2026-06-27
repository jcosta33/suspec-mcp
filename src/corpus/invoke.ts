// The ONE subprocess edge. corpus-mcp never imports corpus-cli's internals — it shells out to the
// `corpus` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The verb is checked against a closed allow-list; positional args are pre-validated by the
// caller (a file path confined to roots, or a task stem). `--json` is always appended; corpus-mcp never
// passes a `--write`/`--force`/`--agent` mutation flag — only the verdict-free `--from`/`--scope` flags
// the safe-write tier (AC-009) needs, each validated by the caller. This keeps corpus-cli at its minimal
// footprint and couples the two repos only through the public, tested JSON interface.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type CorpusEnv = Readonly<{
  bin: string; // the `corpus` binary (env CORPUS_BIN, else 'corpus' on PATH)
  cwd: string; // the workspace root — every invocation runs here (root-confinement, defense in depth)
}>;

// The verbs corpus-mcp may invoke. The read/reconcile set (status/check/review/show) plus the verdict-free
// SAFE-WRITE prepare ops (new/promote, AC-009 / ADR-0077 D8): each scaffolds an artifact (a spec, a task,
// a candidate finding) and writes NO board, NO review result, and issues NO verdict.
const ALLOWED_VERBS = new Set([
  "status",
  "check",
  "review",
  "show",
  "new",
  "promote",
]);

// The ONLY non-`--json` flags corpus-mcp may pass — the verdict-free flags the read + safe-write tiers
// need. NOTABLY ABSENT: `--write` / `--force` / `--agent` (every mutation/verdict flag). A safe-write op
// can only SCAFFOLD a fresh artifact; it can never overwrite (no `--force`) or write a review result.
const ALLOWED_FLAGS = new Set(["--base", "--from", "--scope"]);

export type CorpusInvocation = Readonly<{
  command: string; // the human-readable command line, for the envelope's provenance
  exitCode: number;
}>;

// The CLI emits one JSON object to stdout in BOTH the success case and the structured-error case
// (e.g. `{"error":"Usage","message":"no worktree found …"}` with exit 2). So a parsed object with an
// `error` field is a *structured* failure (surfaced to the agent as a fact), distinct from a launch
// failure (binary missing / non-JSON output), which is an adapter error.
export type CorpusResult =
  | Readonly<{ kind: "ok"; invocation: CorpusInvocation; data: unknown }>
  | Readonly<{
      kind: "structured-error";
      invocation: CorpusInvocation;
      error: { error: string; message: string };
    }>
  | Readonly<{
      kind: "launch-error";
      invocation: CorpusInvocation;
      message: string;
    }>;

function has_error_field(
  value: unknown,
): value is { error: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === "string" &&
    typeof (value as Record<string, unknown>).message === "string"
  );
}

export function invoke_corpus(
  env: CorpusEnv,
  verb: string,
  positional: readonly string[] = [],
  opts: { base?: string; flags?: Readonly<Record<string, string>> } = {},
): CorpusResult {
  if (!ALLOWED_VERBS.has(verb)) {
    // Defense in depth — the tools only ever pass allow-listed verbs; this catches a programming slip.
    throw new Error(
      `corpus-mcp: refusing to invoke a non-allow-listed corpus verb: "${verb}"`,
    );
  }
  const args = [verb, ...positional];
  // The verdict-free flags the read + safe-write tiers need (`--from`/`--scope` for `new task`), each
  // value already validated by the caller. The flag NAME is allow-list-checked here as defense in depth —
  // a programming slip that tried to pass `--write` would throw, never silently mutate.
  for (const [flag, value] of Object.entries(opts.flags ?? {})) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new Error(
        `corpus-mcp: refusing to pass a non-allow-listed flag: "${flag}"`,
      );
    }
    args.push(flag, value);
  }
  if (typeof opts.base === "string" && opts.base.length > 0) {
    args.push("--base", opts.base);
  }
  args.push("--json");
  const command = `corpus ${args.join(" ")}`;

  // A bounded timeout so a hung `corpus` cannot hang the tool call forever (the read/reconcile commands
  // are local and fast; a timeout surfaces as result.error → a launch-error below). `maxBuffer` is raised
  // well above Node's 1 MB default: a large workspace's `status` / `review --json` can exceed 1 MB, and
  // the default truncates it to an unparseable blob that then masquerades as a launch error (corpus-works #22).
  // The try/catch is defense-in-depth: spawnSync THROWS synchronously on some malformed args (e.g. a NUL
  // byte), which the input guards already reject — but a throw must still become a clean launch-error.
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(env.bin, args, {
      cwd: env.cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (caught: unknown) {
    return {
      kind: "launch-error",
      invocation: { command, exitCode: 1 },
      message: `could not run \`${command}\`: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }
  if (result.error) {
    return {
      kind: "launch-error",
      invocation: { command, exitCode: result.status ?? 1 },
      message: `could not launch \`${env.bin}\`: ${result.error.message}`,
    };
  }
  const exitCode = result.status ?? 1;
  const invocation: CorpusInvocation = { command, exitCode };
  const stdout = (result.stdout ?? "").trim();

  let parsed: unknown;
  try {
    parsed = stdout.length > 0 ? JSON.parse(stdout) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    const stderr = (result.stderr ?? "").trim();
    return {
      kind: "launch-error",
      invocation,
      message: `\`${command}\` produced no parseable JSON (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`,
    };
  }
  if (has_error_field(parsed)) {
    return { kind: "structured-error", invocation, error: parsed };
  }
  return { kind: "ok", invocation, data: parsed };
}
