// Runtime schemas for every JSON document accepted from the CLI. Unknown additive fields pass through;
// missing or malformed consumed fields fail the invocation instead of leaking partial data to clients.
//
// ENUM POLICY: a field is modelled as a CLOSED `z.enum` only when the adapter branches on its exact
// value-set. Report `level`, diagnostic code/severity, and their relationship drive exit-code
// validation, so all are checked against the exact supported table.

import { z } from "zod";

export const SUPPORTED_CONTRACT_VERSION = "0.19.0" as const;

export const SUPPORTED_CHECKS = [
  { id: "C001", name: "unique-ids", severity: "hard-error" },
  { id: "C002", name: "duplicate-id", severity: "hard-error" },
  { id: "C003", name: "verify-with", severity: "hard-error" },
  { id: "C004", name: "one-strength-word", severity: "warning" },
  { id: "C007", name: "no-tbd-at-ready", severity: "hard-error" },
  { id: "C008", name: "sources-named", severity: "warning" },
  { id: "C009", name: "broken-source-link", severity: "hard-error" },
  { id: "C010", name: "preserves-refs-resolve", severity: "hard-error" },
  { id: "C011", name: "waves-present", severity: "warning" },
  { id: "C012", name: "coverage", severity: "warning" },
  { id: "C013", name: "verify-evidence-binding", severity: "warning" },
  { id: "C015", name: "citation-resolves", severity: "warning" },
  { id: "C016", name: "supported-needs-evidence", severity: "hard-error" },
  {
    id: "C019",
    name: "malformed-requirement-heading",
    severity: "warning",
  },
  { id: "C020", name: "unresolvable-ref", severity: "hard-error" },
  { id: "C021", name: "intent-present", severity: "hard-error" },
  { id: "C022", name: "task-shape", severity: "hard-error" },
  { id: "C023", name: "task-evidence", severity: "hard-error" },
  { id: "C024", name: "closed-task-resolved", severity: "hard-error" },
] as const;

// --- suspec check <artifact> --json → the per-file check report ------------------------------------
// One diagnostic from the checks contract: `code` is a contract C-code, `severity`/`level` are the
// CLI's own recorded facts (pass-through), `line` is present but null when the check has no anchor.
const SUPPORTED_CHECK_BY_ID = new Map<string, (typeof SUPPORTED_CHECKS)[number]>(
  SUPPORTED_CHECKS.map((check) => [check.id, check]),
);
const C013_CMD_MISMATCH =
  /^coverage row .+'s verify block records a cmd that does not match the requirement's named Verify command$/;

const CheckDiagnostic = z
  .object({
    code: z.string(),
    severity: z.enum(["hard-error", "warning"]),
    message: z.string(),
    line: z.number().nullable(),
  })
  .passthrough()
  .superRefine((diagnostic, ctx) => {
    const expected = SUPPORTED_CHECK_BY_ID.get(diagnostic.code);
    if (expected === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `unknown diagnostic code ${diagnostic.code}`,
        path: ["code"],
      });
      return;
    }
    const severityAllowed =
      diagnostic.severity === expected.severity ||
      (diagnostic.code === "C013" &&
        diagnostic.severity === "hard-error" &&
        C013_CMD_MISMATCH.test(diagnostic.message));
    if (!severityAllowed) {
      ctx.addIssue({
        code: "custom",
        message: `diagnostic ${diagnostic.code} must have severity ${expected.severity}`,
        path: ["severity"],
      });
    }
  });
export const CheckReportSchema = z
  .object({
    type: z.enum(["spec", "task", "review", "change-plan"]),
    level: z.enum(["clean", "warning", "blocking"]),
    path: z.string(),
    diagnostics: z.array(CheckDiagnostic),
  })
  .passthrough()
  .superRefine((report, ctx) => {
    if (Object.hasOwn(report, "checked")) {
      ctx.addIssue({
        code: "custom",
        message: "checked reports must not carry `checked`",
        path: ["checked"],
      });
    }
    if (report.diagnostics.some((diagnostic) => diagnostic.code === "C002")) {
      ctx.addIssue({
        code: "custom",
        message: "C002 belongs only to the file-set report",
        path: ["diagnostics"],
      });
    }
    const expectedLevel = report.diagnostics.some(
      (diagnostic) => diagnostic.severity === "hard-error",
    )
      ? "blocking"
      : report.diagnostics.length > 0
        ? "warning"
        : "clean";
    if (report.level !== expectedLevel) {
      ctx.addIssue({
        code: "custom",
        message: `report level must be ${expectedLevel} for its diagnostics`,
        path: ["level"],
      });
    }
  });

// An artifact whose frontmatter `type:` has no check face: the CLI says so
// cleanly (`checked: false`) instead of running the wrong checks — nothing to validate is not a defect.
export const UncheckedArtifactSchema = z
  .object({
    level: z.literal("clean"),
    path: z.string(),
    type: z.enum(["inventory", "audit", "research"]),
    checked: z.literal(false),
  })
  .passthrough()
  .superRefine((notice, ctx) => {
    if (Object.hasOwn(notice, "diagnostics")) {
      ctx.addIssue({
        code: "custom",
        message: "unchecked notices must not carry `diagnostics`",
        path: ["diagnostics"],
      });
    }
  });

// What `suspec check <artifact> --json` can emit on a success exit: a check report (spec, task,
// review, change-plan) or the unchecked notice.
export const CheckFileSchema = z.union([
  CheckReportSchema,
  UncheckedArtifactSchema,
]);

// The optional final record for a multi-path invocation. It is not an artifact and therefore has no
// artifact type discriminator. The CLI emits it only for one or more blocking C002 collisions.
export const FileSetReportSchema = z
  .object({
    level: z.literal("blocking"),
    path: z.literal("(file set)"),
    diagnostics: z.array(CheckDiagnostic).min(1),
  })
  .passthrough()
  .superRefine((report, ctx) => {
    if (Object.hasOwn(report, "type") || Object.hasOwn(report, "checked")) {
      ctx.addIssue({
        code: "custom",
        message: "file-set reports carry neither `type` nor `checked`",
      });
    }
    if (
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.code !== "C002" || diagnostic.severity !== "hard-error",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "file-set reports contain only hard-error C002 diagnostics",
        path: ["diagnostics"],
      });
    }
  });

export const CheckOutputSchema = z.union([
  CheckFileSchema.refine((report) => report.path !== "(file set)", {
    message: "artifact reports cannot use the file-set marker path",
    path: ["path"],
  }),
  FileSetReportSchema,
]);

export const CheckLineSchema = z.union([
  CheckOutputSchema,
  z.object({ error: z.string(), message: z.string() }).passthrough(),
]);

// --- suspec check --contract --json → the checks contract ------------------------------------------
// The contract dump is a bare object (no report wrapper): the contract version + every core check's
// id/name/severity.
const ContractCheckSchema = z
  .object({ id: z.string(), name: z.string(), severity: z.string() })
  .passthrough();

const ContractChecksSchema = z.array(ContractCheckSchema).superRefine((checks, ctx) => {
  const expectedById = new Map<string, (typeof SUPPORTED_CHECKS)[number]>(
    SUPPORTED_CHECKS.map((check) => [check.id, check]),
  );
  const seen = new Set<string>();

  for (const [index, check] of checks.entries()) {
    if (seen.has(check.id)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate check ID ${check.id}`,
        path: [index, "id"],
      });
      continue;
    }
    seen.add(check.id);

    const expected = expectedById.get(check.id);
    if (expected === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `unknown check ID ${check.id}`,
        path: [index, "id"],
      });
      continue;
    }
    if (check.name !== expected.name) {
      ctx.addIssue({
        code: "custom",
        message: `check ${check.id} must be named ${expected.name}`,
        path: [index, "name"],
      });
    }
    if (check.severity !== expected.severity) {
      ctx.addIssue({
        code: "custom",
        message: `check ${check.id} must have severity ${expected.severity}`,
        path: [index, "severity"],
      });
    }
  }

  for (const expected of SUPPORTED_CHECKS) {
    if (!seen.has(expected.id)) {
      ctx.addIssue({
        code: "custom",
        message: `missing check ID ${expected.id}`,
      });
    }
  }
});

export const ContractSchema = z
  .object({
    version: z.literal(SUPPORTED_CONTRACT_VERSION),
    checks: ContractChecksSchema,
  })
  .passthrough();

// The CLI's structured-error stdout body (`{error, message}` + exit 2) — e.g. a review checked without
// the companion its frontmatter requires.
export const SuspecErrorSchema = z
  .object({ error: z.string(), message: z.string() })
  .passthrough();
