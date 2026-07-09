// zod schemas mirroring the suspec CLI's real v2 `--json` shapes (verified against the binary — the
// store-based surface of ADR-0137 / SPEC-suspec-v2). These are the DRIFT TRIPWIRE — and here is exactly
// where it fires: the TEST SUITE parses every checked-in fixture through these schemas
// (contract.spec.ts), and generated-fixtures.spec.ts regenerates the fixtures against the real binary,
// so a renamed/dropped field fails a test run. At RUNTIME only RunReviewSchema is parsed (envelope.ts);
// the other payload reads go through slices.ts's defensive helpers, which degrade to missing fields
// rather than failing loudly. So the wire trips in CI/dev, not in the running server — do not read this
// file as a live runtime guarantee for every shape.
// `.passthrough()` keeps unknown extra fields (additive CLI changes don't break us); the named fields
// are the ones suspec-mcp actually reads.
//
// ENUM POLICY (AC-011, audit F7): a field is modelled as a CLOSED `z.enum` ONLY when the adapter BRANCHES
// on its exact value-set — so a new/renamed value the adapter cannot interpret trips the wire. A field the
// adapter only PASSES THROUGH (surfaces in `data` / a concise slice, never switches on) is modelled as
// `z.string()`: a benign additive CLI enum value must NOT convert into a suspec-mcp break for no consumer
// benefit. The only payload enum the adapter branches on in v2 is the store-lint diagnostic `severity`
// (`=== "hard-error"` scales the derived human-attention severity), so it stays closed; `level`, every
// evidence-row `status`/`provenance`, and the store-artifact/next `kind`s are pass-through → `z.string()`.
// The always-present top-level lists stay required (a dropped list the adapter iterates still trips).

import { z } from "zod";

// --- suspec status --json → the store summary (status.ts: listing + next ranking) ------------------
// One store artifact with its age (listStoreArtifacts.ts `StoreArtifactAge`). `kind` is pass-through.
const StoreArtifact = z
  .object({ filename: z.string(), kind: z.string(), ageDays: z.number() })
  .passthrough();
// One attention item from the `next` ranking (nextAction.ts `NextItem`). All pass-through fields.
const NextItem = z
  .object({
    rank: z.number(),
    kind: z.string(),
    ref: z.string(),
    detail: z.string(),
    action: z.string(),
  })
  .passthrough();
export const StoreStatusSchema = z
  .object({
    level: z.string(),
    active: z.array(StoreArtifact),
    archived: z.array(StoreArtifact),
    next: z.array(NextItem),
  })
  .passthrough();
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

// --- suspec store list --json (store.ts `list`) ----------------------------------------------------
export const StoreListSchema = z
  .object({
    level: z.string(),
    store: z.string(),
    active_count: z.number(),
    archived_count: z.number(),
    active: z.array(StoreArtifact),
    archived: z.array(StoreArtifact),
  })
  .passthrough();
export type StoreList = z.infer<typeof StoreListSchema>;

// --- suspec check --json (no args) → the store lint (lintStoreArtifacts.ts) ------------------------
// A store-lint diagnostic (lintRunArtifacts.ts `StoreLintDiagnostic`): `check` is a contract C-code or
// a store-local code (RUN01, EV01..EV04 — EV04 = a capture block with no backing line in the CLI-owned
// capture ledger, hard-error) — pass-through. `severity` is CLOSED: the adapter branches on
// `=== "hard-error"` to scale the derived human-attention severity (envelope.ts).
const StoreLintDiagnostic = z
  .object({
    check: z.string(),
    severity: z.enum(["hard-error", "warning"]),
    message: z.string(),
  })
  .passthrough();
const StoreLintArtifact = z
  .object({ path: z.string(), diagnostics: z.array(StoreLintDiagnostic) })
  .passthrough();
export const StoreLintSchema = z
  .object({
    level: z.string(),
    runCount: z.number(),
    specCount: z.number(),
    artifacts: z.array(StoreLintArtifact),
  })
  .passthrough();
export type StoreLint = z.infer<typeof StoreLintSchema>;

// --- suspec check <file> --json (checkSpec.ts / checkReviewFile.ts / checkChangePlan.ts) ------------
// Unchanged from v1: the per-file artifact check. Diagnostic `code`/`severity` are pass-through.
const FileDiagnostic = z
  .object({
    code: z.string(),
    severity: z.string(),
    message: z.string(),
    line: z.number().nullable().optional(),
  })
  .passthrough();
export const FileCheckSchema = z
  .object({
    level: z.string(),
    path: z.string(),
    diagnostics: z.array(FileDiagnostic),
  })
  .passthrough();
export type FileCheck = z.infer<typeof FileCheckSchema>;

// --- suspec review <RUN> --json → the run-vs-spec reconcile (review.ts, SPEC-suspec-v2 AC-013) ------
// Two read-only layers, facts only, no verdict: `lint` (the run's store artifacts through the checks
// contract) and `evidence` (every spec AC against the run's evidence records — the same rows `done`
// gates on). `gaps` lists the AC ids short of the gate. Evidence-row fields are pass-through: the
// adapter derives human-attention from the `gaps` list + each diagnostic's message, never from `status`.
const EvidenceRow = z
  .object({
    ac: z.string(),
    command: z.string().nullable(),
    exit: z.number().nullable(),
    evidenceRef: z.string().nullable(),
    provenance: z.string().nullable(),
    status: z.string(),
  })
  .passthrough();
export const RunReviewSchema = z
  .object({
    level: z.string(),
    runSlug: z.string(),
    specId: z.string().nullable(),
    lint: z.array(StoreLintArtifact),
    evidence: z.array(EvidenceRow),
    gaps: z.array(z.string()),
  })
  .passthrough();
export type RunReview = z.infer<typeof RunReviewSchema>;

// --- suspec show checks --json → the checks contract (showArtifact.ts) ------------------------------
// `severity` here is pass-through.
export const ShowChecksSchema = z
  .object({
    level: z.literal("clean"),
    kind: z.literal("checks"),
    value: z
      .object({
        version: z.string(),
        checks: z.array(
          z
            .object({ id: z.string(), name: z.string(), severity: z.string() })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
export type ShowChecks = z.infer<typeof ShowChecksSchema>;

// --- suspec show <kind> <ref> --json → the store loader (showArtifact.ts ShowResult) -----------------
// The store-resolving loader face (post-realignment CLI: every kind resolves by id-or-slug against the
// store's flat `<kind>-*.md` files, archive/ as fallback). The adapter RELAYS the projection whole and
// branches on none of its fields, so per the enum/field policy only the uniform ShowResult wrapper is
// pinned: `level` (a read never warns — a lookup/parse failure is the CLI's structured exit-2 error,
// not a degraded success), the echoed `kind` (pass-through), and the presence of an object `value`
// (the per-kind projection — spec/task/review are parsed records; run/intake are the honest
// frontmatter+body split; its inner fields are the CLI's own and deliberately unpinned here).
export const ShowArtifactSchema = z
  .object({
    level: z.literal("clean"),
    kind: z.string(),
    value: z.object({}).passthrough(),
  })
  .passthrough();
export type ShowArtifact = z.infer<typeof ShowArtifactSchema>;

// --- the SAFE-WRITE tier — verdict-free prepare-op reports ------------------------------------------
// Each scaffold returns a small report the adapter passes through (it surfaces the created artifact's
// path/id; it branches on none of these). These reports carry NO verdict; the contract pins the fields
// the adapter relays so a rename/drop trips the wire.

// suspec write spec "<intent>" --json (write.ts) — the ONE spec scaffold, store-rooted. suspec-mcp
// never passes `--launch`, so `launched` is always false on this path (still pinned: a drop trips).
export const WriteSpecSchema = z
  .object({
    level: z.string(),
    spec: z.string(),
    spec_path: z.string(),
    created: z.boolean(),
    launched: z.boolean(),
  })
  .passthrough();
export type WriteSpec = z.infer<typeof WriteSpecSchema>;

// suspec new task --from <SPEC> [--scope …] --json → CutTaskReport (cutTask.ts) — the store task slice.
export const CutTaskSchema = z
  .object({
    level: z.string(),
    path: z.string(),
    taskId: z.string(),
    specId: z.string(),
    scope: z.array(z.string()),
    autoSuffixed: z.boolean(),
  })
  .passthrough();
export type CutTask = z.infer<typeof CutTaskSchema>;

// The CLI's structured-error stdout body (unixOutcome.ts `emit_error`): `{error, message}` + exit 2.
export const SuspecErrorSchema = z
  .object({ error: z.string(), message: z.string() })
  .passthrough();
export type SuspecError = z.infer<typeof SuspecErrorSchema>;
