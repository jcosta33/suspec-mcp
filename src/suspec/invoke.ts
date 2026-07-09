// The ONE subprocess edge. suspec-mcp never imports suspec-cli's internals — it shells out to the
// `suspec` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The verb is checked against a closed allow-list; positional args are pre-validated by the
// caller (a file path confined to roots, or a task stem). `--json` is always appended; suspec-mcp never
// passes a `--write`/`--force`/`--agent` mutation flag — only the verdict-free `--from`/`--scope` flags
// the safe-write tier (AC-009) needs, each validated by the caller. This keeps suspec-cli at its minimal
// footprint and couples the two repos only through the public, tested JSON interface.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SuspecEnv = Readonly<{
  bin: string; // the `suspec` binary (env SUSPEC_BIN, else 'suspec' on PATH)
  cwd: string; // the workspace root — every invocation runs here (root-confinement, defense in depth)
}>;

// The verbs suspec-mcp may invoke (the v2 store surface, ADR-0137). The read/reconcile set
// (status/check/review/show/store) plus the verdict-free SAFE-WRITE prepare ops (`write spec` /
// `new task`): each scaffolds ONE store artifact — never a result or a verdict. NOTABLY ABSENT:
// `promote` (opens a GitHub issue + archives the finding — network + mutation, not a scaffold),
// `work` / `fix` / `done` / `evidence` (launch runners, close gates, or execute commands).
const ALLOWED_VERBS = new Set([
  "status",
  "check",
  "review",
  "show",
  "store",
  "new",
  "write",
]);

// `store` grew mutating subcommands (`migrate` rewrites every artifact's grammar_version, `gc` and
// `purge` DELETE artifacts) — the verb alone is no longer a read guarantee, so the subcommand is
// allow-listed too. Only the read faces pass; `migrate`/`gc`/`purge` are store MAINTENANCE the human
// runs via the CLI (they mutate/delete artifacts — nothing reconcile-only about them), and `doctor`
// is not consumed by any tool yet, so it is not opened pre-emptively. `store path` prints the store
// dir but resolves NON-probe — on a fresh repo it CREATES the store dir + `.repo-path` marker. That
// write is the same benign store-materialization `write spec` already performs, so it could join the
// safe-write tier — but no MCP tool consumes it (every store-reading tool gets the store path from
// the CLI's own output), so like `doctor` it stays closed until a tool actually needs it.
const ALLOWED_STORE_SUBCOMMANDS = new Set(["list"]);

// The ONLY non-`--json` flags suspec-mcp may pass — the verdict-free flags the safe-write tier
// needs. NOTABLY ABSENT: `--write` / `--force` / `--agent` / `--launch` (every mutation/dispatch
// flag) — so a safe-write op can only SCAFFOLD a fresh artifact, never overwrite, mutate, or launch.
const ALLOWED_FLAGS = new Set(["--from", "--scope"]);

export type SuspecInvocation = Readonly<{
  command: string; // the human-readable command line, for the envelope's provenance
  exitCode: number;
}>;

// The CLI emits one JSON object to stdout in BOTH the success case and the structured-error case
// (e.g. `{"error":"Usage","message":"no worktree found …"}` with exit 2). So a parsed object with an
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
  opts: { flags?: Readonly<Record<string, string>> } = {},
): SuspecResult {
  if (!ALLOWED_VERBS.has(verb)) {
    // Defense in depth — the tools only ever pass allow-listed verbs; this catches a programming slip.
    throw new Error(
      `suspec-mcp: refusing to invoke a non-allow-listed suspec verb: "${verb}"`,
    );
  }
  if (verb === "store" && !ALLOWED_STORE_SUBCOMMANDS.has(positional[0] ?? "")) {
    // Same defense in depth, one level down: `store migrate|gc|purge` mutate/delete artifacts.
    throw new Error(
      `suspec-mcp: refusing to invoke a non-allow-listed store subcommand: "${positional[0] ?? ""}"`,
    );
  }
  const args = [verb, ...positional];
  // The verdict-free flags the safe-write tier needs (`--from`/`--scope` for `new task`), each
  // value already validated by the caller. The flag NAME is allow-list-checked here as defense in depth —
  // a programming slip that tried to pass `--write` would throw, never silently mutate.
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

  // A bounded timeout so a hung `suspec` cannot hang the tool call forever (the read/reconcile commands
  // are local and fast; a timeout surfaces as result.error → a launch-error below). `maxBuffer` is raised
  // well above Node's 1 MB default: a large workspace's `status` / `review --json` can exceed 1 MB, and
  // the default truncates it to an unparseable blob that then masquerades as a launch error (private workspace #22).
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
