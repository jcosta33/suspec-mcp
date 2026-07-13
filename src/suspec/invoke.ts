// The ONE subprocess edge. suspec-mcp never imports suspec-cli's internals — it shells out to the
// `suspec` CLI's `--json` contract with a FIXED argv array (never a shell string, never a client-injected
// flag). The CLI's whole surface is one verb (`suspec check`), so the allow-list is exactly
// that: `check`, plus the review-companion flags (`--spec`/`--task`, each value a full path already
// validated by the tool boundary) and the bare `--contract`. `--json` is always appended;
// suspec-mcp passes no other flag. This keeps suspec-cli at its minimal footprint and couples the two
// repos only through the public, tested JSON interface.

import { execFile, type ExecFileException } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import {
  CheckOutputSchema,
  ContractSchema,
  SuspecErrorSchema,
} from "./contract.ts";

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
      data: unknown;
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
const SUPPORTED_EXIT_CODES = new Set([0, 1, 2]);

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

function parse_json(text: string): unknown {
  return JSON.parse(text);
}

function parse_jsonl(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parse_json);
}

function validation_message(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `CLI JSON violates the supported contract: ${issues}`;
}

export function distinct_primary_paths(
  paths: readonly string[],
  cwd: string,
): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    let identity: string;
    try {
      const stats = statSync(resolve(cwd, path), { bigint: true });
      identity = `${stats.dev}:${stats.ino}`;
    } catch {
      identity = resolve(cwd, path);
    }
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function invoke_suspec(
  env: SuspecEnv,
  verb: string,
  positional: readonly string[] = [],
  opts: {
    flags?: Readonly<Record<string, string>>;
    bare?: readonly string[];
    expected: "contract" | "reports";
  },
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
      if (!SUPPORTED_EXIT_CODES.has(exitCode)) {
        const stderr = (result.stderr ?? "").trim();
        return {
          kind: "launch-error",
          invocation,
          message: `\`${command}\` returned unsupported exit code ${exitCode}; expected 0, 1, or 2${stderr ? `: ${stderr}` : ""}`,
        };
      }
      const stdout = (result.stdout ?? "").trim();

      let parsed: unknown;
      try {
        parsed =
          stdout.length > 0
            ? opts.expected === "reports"
              ? parse_jsonl(stdout)
              : parse_json(stdout)
            : undefined;
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
      const payloadSchema =
        opts.expected === "contract" ? ContractSchema : CheckOutputSchema;
      const documents = opts.expected === "reports" ? (parsed as unknown[]) : [parsed];
      const validated: unknown[] = [];
      for (const document of documents) {
        const payloadResult = payloadSchema.safeParse(document);
        const errorResult = SuspecErrorSchema.safeParse(document);
        if (payloadResult.success && errorResult.success) {
          return {
            kind: "launch-error",
            invocation,
            message: `CLI JSON matches both success and structured-error schemas`,
          };
        }
        if (!payloadResult.success && !errorResult.success) {
          return {
            kind: "launch-error",
            invocation,
            message: validation_message(payloadResult.error),
          };
        }
        validated.push(
          payloadResult.success ? payloadResult.data : errorResult.data,
        );
      }
      const data = opts.expected === "reports" ? validated : validated[0];
      const structuredErrorCount = validated.filter(
        (document) => SuspecErrorSchema.safeParse(document).success,
      ).length;
      if (
        structuredErrorCount > 0 &&
        structuredErrorCount < validated.length
      ) {
        return {
          kind: "launch-error",
          invocation,
          message: `\`${command}\` emitted a mixed report/structured error stream`,
        };
      }
      if (structuredErrorCount === validated.length && exitCode !== 2) {
        return {
          kind: "launch-error",
          invocation,
          message: `\`${command}\` emitted a structured error at exit ${exitCode}; structured errors require exit 2`,
        };
      }
      if (structuredErrorCount === validated.length) {
        return { kind: "structured-error", invocation, data };
      }
      if (opts.expected === "contract") {
        if (exitCode !== 0) {
          return {
            kind: "launch-error",
            invocation,
            message: `\`${command}\` emitted a checks contract at exit ${exitCode}; contracts require exit 0`,
          };
        }
        return { kind: "ok", invocation, data };
      }

      const exitByLevel = { clean: 0, warning: 1, blocking: 2 } as const;
      const reports = validated as {
        level: keyof typeof exitByLevel;
        path: string;
        diagnostics?: { code: string; severity: string }[];
      }[];
      const expectedPrimaryPaths = distinct_primary_paths(positional, env.cwd);
      const primaryPathsMatch = expectedPrimaryPaths.every(
        (path, index) => reports[index]?.path === path,
      );
      const hasNoSetReport = reports.length === expectedPrimaryPaths.length;
      const setReport = reports[expectedPrimaryPaths.length];
      const hasOneFinalSetReport =
        expectedPrimaryPaths.length > 1 &&
        reports.length === expectedPrimaryPaths.length + 1 &&
        setReport?.path === "(file set)" &&
        !Object.hasOwn(setReport, "type") &&
        !Object.hasOwn(setReport, "checked") &&
        setReport.level === "blocking" &&
        Array.isArray(setReport.diagnostics) &&
        setReport.diagnostics.length > 0 &&
        setReport.diagnostics.every(
          (diagnostic) =>
            diagnostic.code === "C002" && diagnostic.severity === "hard-error",
        );
      if (!primaryPathsMatch || (!hasNoSetReport && !hasOneFinalSetReport)) {
        return {
          kind: "launch-error",
          invocation,
          message: `\`${command}\` did not return one report for each ordered primary path followed by at most one file-set report`,
        };
      }
      const expectedExit = Math.max(
        ...reports.map((report) => exitByLevel[report.level]),
      );
      if (exitCode !== expectedExit) {
        const maxLevel = (["clean", "warning", "blocking"] as const)[
          expectedExit
        ];
        return {
          kind: "launch-error",
          invocation,
          message: `\`${command}\` emitted a ${maxLevel} report stream at exit ${exitCode}; ${maxLevel} reports require exit ${expectedExit}`,
        };
      }
      return { kind: "ok", invocation, data };
    })
    .catch(
      (caught: unknown): SuspecResult => ({
        kind: "launch-error",
        invocation: { command, exitCode: 1 },
        message: `could not run \`${command}\`: ${caught instanceof Error ? caught.message : String(caught)}`,
      }),
    );
}
