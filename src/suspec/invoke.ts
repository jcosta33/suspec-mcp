// The ONE subprocess edge. suspec-mcp never imports suspec-cli's internals — it shells out to the
// `suspec` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The CLI's whole surface is one verb (`suspec check`, ADR-0143), so the allow-list is exactly
// that: `check`, plus the review-companion flags (`--spec`/`--task`, each value a full path already
// validated by the tool boundary) and the bare `--contract`. `--json` is always appended;
// suspec-mcp passes no other flag. This keeps suspec-cli at its minimal footprint and couples the two
// repos only through the public, tested JSON interface.

import { execFile, type ExecFileException } from "node:child_process";

export type SuspecEnv = Readonly<{
  bin: string; // the `suspec` binary (env SUSPEC_BIN, else 'suspec' on PATH)
  cwd: string; // subprocess working directory only; full artifact paths do not resolve against it
  timeoutMs?: number; // test/embedding override; the server uses the bounded default
}>;

// The one verb the CLI exposes — anything else is refused before a subprocess ever spawns.
const ALLOWED_VERBS = new Set(["check"]);

// The VALUED flags suspec-mcp may pass: review companions whose full paths the tool already validated.
// The CLI has no mutation or dispatch flag, and a programming slip that
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

type ExecOutcome = Readonly<{
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
}>;

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

function quote_arg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run_cli(
  env: SuspecEnv,
  args: readonly string[],
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(
      env.bin,
      args,
      {
        cwd: env.cwd,
        encoding: "utf8",
        timeout: env.timeoutMs ?? TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

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
): Promise<SuspecResult> {
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
  // The review-companion flags (`--spec`/`--task`), each full path already validated by the caller. The
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
  const command = [env.bin, ...args].map(quote_arg).join(" ");

  // A bounded timeout so a hung `suspec` cannot hang the tool call forever (a check is local and fast;
  // a timeout surfaces as result.error → a launch-error below). `maxBuffer` is raised well above Node's
  // 1 MB default: a large artifact's report can exceed it, and the default truncates it to an
  // unparseable blob that then masquerades as a launch error.
  return run_cli(env, args)
    .then((result): SuspecResult => {
      const errorCode = result.error?.code;
      if (result.error !== null && typeof errorCode !== "number") {
        const action = errorCode === "ENOENT" ? "launch" : "complete";
        return {
          kind: "launch-error",
          invocation: { command, exitCode: 1 },
          message: `could not ${action} \`${env.bin}\`: ${result.error.message}`,
        };
      }
      const exitCode = typeof errorCode === "number" ? errorCode : 0;
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
    })
    .catch(
      (caught: unknown): SuspecResult => ({
        kind: "launch-error",
        invocation: { command, exitCode: 1 },
        message: `could not run \`${command}\`: ${caught instanceof Error ? caught.message : String(caught)}`,
      }),
    );
}
