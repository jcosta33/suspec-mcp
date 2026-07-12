// zod schemas mirroring the suspec CLI's real `--json` shapes (verified against the binary — the
// path-explicit check surface of ADR-0143). These are the DRIFT TRIPWIRE — and here is exactly where it
// fires: the TEST SUITE parses every checked-in fixture through these schemas (contract.spec.ts), and
// generated-fixtures.spec.ts regenerates the fixtures against the real binary, so a renamed/dropped
// field fails a test run. At RUNTIME nothing parses through these schemas — the payload reads go through
// slices.ts's defensive helpers, which degrade to missing fields rather than failing loudly. So the wire
// trips in CI/dev, not in the running server — do not read this file as a live runtime guarantee.
// `.passthrough()` keeps unknown extra fields (additive CLI changes don't break us); the named fields
// are the ones suspec-mcp actually reads.
//
// ENUM POLICY (AC-011, audit F7): a field is modelled as a CLOSED `z.enum` ONLY when the adapter
// BRANCHES on its exact value-set. The adapter branches on NO payload enum on this surface — a
// diagnostic's `severity` and a report's `level` are relayed, never switched on — so every such field
// is `z.string()`: a benign additive CLI value must NOT convert into a suspec-mcp break for no
// consumer benefit.

import { z } from "zod";

// --- suspec check <artifact> --json → the per-file check report ------------------------------------
// One diagnostic from the checks contract: `code` is a contract C-code, `severity`/`level` are the
// CLI's own recorded facts (pass-through), `line` is present but null when the check has no anchor.
const CheckDiagnostic = z
  .object({
    code: z.string(),
    severity: z.string(),
    message: z.string(),
    line: z.number().nullable(),
  })
  .passthrough();
export const CheckReportSchema = z
  .object({
    level: z.string(),
    path: z.string(),
    diagnostics: z.array(CheckDiagnostic),
  })
  .passthrough();

// An artifact whose frontmatter `type:` has no check face: the CLI says so
// cleanly (`checked: false`) instead of running the wrong checks — nothing to validate is not a defect.
export const UncheckedArtifactSchema = z
  .object({
    level: z.literal("clean"),
    path: z.string(),
    type: z.string(),
    checked: z.literal(false),
  })
  .passthrough();

// What `suspec check <artifact> --json` can emit on a success exit: a check report (spec, review,
// change-plan) or the unchecked notice.
export const CheckFileSchema = z.union([
  CheckReportSchema,
  UncheckedArtifactSchema,
]);

// --- suspec check --contract --json → the checks contract ------------------------------------------
// The contract dump is a bare object (no report wrapper): the contract version + every core check's
// id/name/severity.
export const ContractSchema = z
  .object({
    version: z.string(),
    checks: z.array(
      z
        .object({ id: z.string(), name: z.string(), severity: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();

// The CLI's structured-error stdout body (`{error, message}` + exit 2) — e.g. a review checked without
// the companion its frontmatter requires.
export const SuspecErrorSchema = z
  .object({ error: z.string(), message: z.string() })
  .passthrough();
