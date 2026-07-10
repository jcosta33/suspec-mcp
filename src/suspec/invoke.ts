// The ONE subprocess edge. suspec-mcp never imports suspec-cli's internals — it shells out to the
// `suspec` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The CLI's whole surface is one verb (`suspec check`, ADR-0143), so the allow-list is exactly
// that: `check`, plus the two review-companion flags (`--spec`/`--task`, each value a path the caller has
// already confined to the workspace root) and the bare `--contract`. `--json` is always appended;
// suspec-mcp passes no other flag. This keeps suspec-cli at its minimal footprint and couples the two
// repos only through the public, tested JSON interface.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SuspecEnv = Readonly<{
  bin: string; // the `suspec` binary (env SUSPEC_BIN, else 'suspec' on PATH)
  cwd: string; // the workspace root — every invocation runs here (root-confinement, defense in depth)
}>;

// The one verb the CLI exposes — anything else is refused before a subprocess ever spawns.
const ALLOWED_VERBS = new Set(["check"]);

// The VALUED flags suspec-mcp may pass: the review companions, whose path values the caller has already
// confined to the workspace root. The CLI has no mutation or dispatch flag, and a programming slip that
// tried to invent one would throw here, never silently reach the subprocess.
const ALLOWED_FLAGS = new Set(["--spec", "--task"]);

// The BARE (valueless) flags: `--contract` selects the checks-contract dump.
const ALLOWED_BARE_FLAGS = new Set(["--contract"]);

export type SuspecInvocation = Readonly<{
  command: string; // the human-readable command line, for the envelope's provenance
  exitCode: number;
}>;

// The CLI emits one JSON object to stdout in BOTH the success case and the structured-error case
// (e.g. `{"error":"Usage","message":"… missing --task …"}` with exit 2). So a parsed object with an
// `error` field is a *structured* failure (surfaced to the agent as a fact), distinct from a launch
// failure (binary missing / non-JSON output), which is an adapter error.
export type SuspecResult =
  | Readonly<{ kind: "ok"; invocation: SuspecInvocation; data: unknown }>
  | Readonly<{
      kind: "structured-error";
      invocation: SuspecInvocation;
      error: { error: string; message: string };
    }>
  | Readonly<{
      kind: "launch-error";
      invocation: SuspecInvocation;
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

export function invoke_suspec(
  env: SuspecEnv,
  verb: string,
  positional: readonly string[] = [],
  opts: {
    flags?: Readonly<Record<string, string>>;
    bare?: readonly string[];
  } = {},
): SuspecResult {
  if (!ALLOWED_VERBS.has(verb)) {
    // Defense in depth — the tools only ever pass allow-listed verbs; this catches a programming slip.
    throw new Error(
      `suspec-mcp: refusing to invoke a non-allow-listed suspec verb: "${verb}"`,
    );
  }
  const args = [verb, ...positional];
  // The bare flags (`--contract`), allow-list-checked as defense in depth like the verb.
  for (const flag of opts.bare ?? []) {
    if (!ALLOWED_BARE_FLAGS.has(flag)) {
      throw new Error(
        `suspec-mcp: refusing to pass a non-allow-listed flag: "${flag}"`,
      );
    }
    args.push(flag);
  }
  // The review-companion flags (`--spec`/`--task`), each value already confined by the caller. The
  // flag NAME is allow-list-checked here as defense in depth — a slip that tried to pass anything
  // else would throw, never silently reach the CLI.
  for (const [flag, value] of Object.entries(opts.flags ?? {})) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new Error(
        `suspec-mcp: refusing to pass a non-allow-listed flag: "${flag}"`,
      );
    }
    args.push(flag, value);
  }
  args.push("--json");
  const command = `suspec ${args.join(" ")}`;

  // A bounded timeout so a hung `suspec` cannot hang the tool call forever (a check is local and fast;
  // a timeout surfaces as result.error → a launch-error below). `maxBuffer` is raised well above Node's
  // 1 MB default: a large artifact's report can exceed it, and the default truncates it to an
  // unparseable blob that then masquerades as a launch error (private workspace #22).
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
  const invocation: SuspecInvocation = { command, exitCode };
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
