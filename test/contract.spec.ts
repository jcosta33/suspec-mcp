import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CheckReportSchema,
  FileSetReportSchema,
  CheckOutputSchema,
  UncheckedArtifactSchema,
  CheckFileSchema,
  CheckLineSchema,
  ContractSchema,
  SuspecErrorSchema,
} from "../src/suspec/contract.ts";

// The DRIFT TRIPWIRE has two halves that together pin stub → contract → reality:
//   (1) the captured fixtures were recorded from the REAL `suspec check … --json` (a scratch dir of
//       artifacts, relative paths). Parsing them proves the CONTRACT matches reality; a suspec-cli
//       rename or dropped field fails the parse here instead of the adapter silently producing wrong
//       output.
//   (2) the test STUB (the binary the integration tests run against) is parsed through the SAME
//       schemas, so the stub cannot drift from the contract the fixtures define — closing the gap
//       where the stub, the fixtures, and the CLI were three separate truths and the tests stayed
//       green on a divergence.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const stubBin = join(here, "fixtures", "stub-suspec.mjs");

// Run the stub in a scratch dir carrying the artifact set the check surface needs (the stub reads
// the checked file itself, like the real CLI).
function runStub(args: string[]): { data: unknown; exit: number | null } {
  const dir = mkdtempSync(join(tmpdir(), "suspec-mcp-contract-"));
  try {
    writeFileSync(
      join(dir, "spec.md"),
      "---\ntype: spec\nid: SPEC-x\n---\n\n## Requirements\n",
    );
    writeFileSync(
      join(dir, "task.md"),
      "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-x\nscope: [AC-001]\n---\n",
    );
    writeFileSync(
      join(dir, "not-a-task.md"),
      "---\ntype: spec\nid: TASK-x\n---\n",
    );
    writeFileSync(
      join(dir, "audit.md"),
      "---\ntype: audit\nid: AUDIT-x\n---\n",
    );
    writeFileSync(
      join(dir, "scope-less-task.md"),
      "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-x\n---\n",
    );
    writeFileSync(
      join(dir, "wrong-source-task.md"),
      "---\ntype: task\nid: TASK-x\nsource:\n  - SPEC-other\nscope: [AC-001]\n---\n",
    );
    writeFileSync(
      join(dir, "not-a-spec.md"),
      "---\ntype: task\nid: SPEC-x\n---\n",
    );
    writeFileSync(
      join(dir, "review.md"),
      "---\ntype: review\nid: REVIEW-x\nspec: SPEC-x\ntask: TASK-x\nreviewer: fixture-reviewer\n---\n\n## Requirement coverage\n",
    );
    writeFileSync(
      join(dir, "review-notask.md"),
      "---\ntype: review\nid: REVIEW-y\nspec: SPEC-x\nreviewer: fixture-reviewer\n---\n\n## Requirement coverage\n",
    );
    writeFileSync(
      join(dir, "review-task-list.md"),
      "---\ntype: review\nid: REVIEW-list\nspec: SPEC-x\ntask:\n  - TASK-x\n  - TASK-other\nreviewer: fixture-reviewer\n---\n\n## Requirement coverage\n",
    );
    writeFileSync(
      join(dir, "review-task-mismatch.md"),
      "---\ntype: review\nid: REVIEW-mismatch\nspec: SPEC-x\ntask: TASK-other\nreviewer: fixture-reviewer\n---\n\n## Requirement coverage\n",
    );
    writeFileSync(
      join(dir, "review-quoted-bom.md"),
      '\ufeff---\ntype: "review"\nid: REVIEW-normalized\nspec: SPEC-x\nreviewer: fixture-reviewer\n---\n\n## Requirement coverage\n',
    );
    const res = spawnSync(stubBin, [...args, "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
    return { data: JSON.parse(res.stdout.trim()), exit: res.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the contract matches the real --json shapes (captured fixtures)", () => {
  it("check <spec> --json → a clean CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-spec.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("clean");
      expect(parsed.data.diagnostics).toEqual([]);
    }
  });

  it("check <review> --spec --task --json → a clean CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-review.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("clean");
    }
  });

  it("check <task> --json → a deterministic CheckReport", () => {
    const parsed = CheckReportSchema.safeParse(fixture("check-task.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.path).toBe("task-demo.md");
    }
  });

  it("a diagnostic-carrying review report pins the diagnostic fields (code/severity/message/line)", () => {
    const parsed = CheckReportSchema.safeParse(
      fixture("check-review-diagnostics.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // the real capture carries the empty-evidence Supported row's diagnostic
      expect(parsed.data.diagnostics.length).toBeGreaterThan(0);
      expect(parsed.data.diagnostics.map((d) => d.code)).toContain("C016");
      expect(parsed.data.level).toBe("blocking");
    }
  });

  it("a mismatched task companion produces a blocking C020 report", () => {
    const parsed = CheckReportSchema.safeParse(
      fixture("check-review-task-mismatch.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("blocking");
      expect(parsed.data.diagnostics.map((item) => item.code)).toContain(
        "C020",
      );
    }
  });

  it("check on an artifact type with no check face → UncheckedArtifact (checked:false, exit-0 shape)", () => {
    const parsed = UncheckedArtifactSchema.safeParse(
      fixture("check-unchecked.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("audit");
      expect(parsed.data.checked).toBe(false);
    }
  });

  it("accepts only the three recognized unchecked artifact types", () => {
    for (const type of ["inventory", "audit", "research"]) {
      expect(
        UncheckedArtifactSchema.safeParse({
          level: "clean",
          path: `${type}.md`,
          type,
          checked: false,
        }).success,
        type,
      ).toBe(true);
    }
    for (const type of [
      "spec",
      "task",
      "review",
      "change-plan",
      "finding",
      "inspection",
    ]) {
      expect(
        UncheckedArtifactSchema.safeParse({
          level: "clean",
          path: `${type}.md`,
          type,
          checked: false,
        }).success,
        type,
      ).toBe(false);
    }
  });

  it("keeps checked reports and unchecked notices disjoint", () => {
    expect(
      CheckReportSchema.safeParse({
        level: "clean",
        path: "spec.md",
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "clean",
        path: "spec.md",
        diagnostics: [],
        checked: false,
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        level: "blocking",
        path: "audit.md",
        diagnostics: [
          {
            code: "C021",
            name: "intent-present",
            severity: "hard-error",
            message: "spec has no non-empty Intent section",
            line: null,
          },
        ],
        type: "audit",
        checked: false,
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        level: "clean",
        path: "audit.md",
        type: "audit",
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      UncheckedArtifactSchema.safeParse({
        level: "clean",
        path: "audit.md",
        type: "audit",
        checked: false,
        diagnostics: [],
      }).success,
    ).toBe(false);
  });

  it("every check capture parses under the CheckFile union", () => {
    for (const name of [
      "check-spec.json",
      "check-task.json",
      "check-review.json",
      "check-review-diagnostics.json",
      "check-review-task-mismatch.json",
      "check-unchecked.json",
    ]) {
      expect(
        CheckFileSchema.safeParse(fixture(name)).success,
        `${name} must parse as a CheckFile`,
      ).toBe(true);
    }
  });

  it("multi-path captures preserve report order and carry an optional C002 file-set report", () => {
    const multiple = fixture("check-multiple.json") as unknown[];
    expect(multiple).toHaveLength(2);
    expect(
      multiple.every((item) => CheckFileSchema.safeParse(item).success),
    ).toBe(true);

    const duplicate = fixture("check-duplicate-id.json") as unknown[];
    expect(duplicate).toHaveLength(3);
    const setReport = FileSetReportSchema.parse(duplicate[2]);
    expect(setReport.path).toBe("(file set)");
    expect(setReport.diagnostics.map((item) => item.code)).toContain("C002");
  });

  it("keeps file-set reports distinct from artifact reports", () => {
    const diagnostic = {
      code: "C002",
      severity: "hard-error",
      message: "duplicate id",
      line: null,
    } as const;
    expect(
      FileSetReportSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
    expect(
      CheckOutputSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
    expect(
      FileSetReportSchema.safeParse({
        path: "(file set)",
        level: "blocking",
        diagnostics: [{ ...diagnostic, code: "C021" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        path: "spec.md",
        level: "blocking",
        diagnostics: [diagnostic],
        type: "spec",
      }).success,
    ).toBe(false);
  });

  it("check --contract --json → Contract (version + the core checks)", () => {
    const parsed = ContractSchema.safeParse(fixture("contract.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe("0.22.0");
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      for (const check of parsed.data.checks) {
        expect(check.id).toMatch(/^C\d{3}$/);
      }
    }
  });

  it.each([
    ["empty", (contract: { checks: unknown[] }) => contract.checks.splice(0)],
    ["partial", (contract: { checks: unknown[] }) => contract.checks.splice(1)],
    [
      "duplicate ID",
      (contract: { checks: unknown[] }) =>
        contract.checks.push(contract.checks[0]),
    ],
    [
      "unknown ID",
      (contract: { checks: { id: string }[] }) => {
        contract.checks[0].id = "C999";
      },
    ],
    [
      "corrupted name",
      (contract: { checks: { name: string }[] }) => {
        contract.checks[0].name = "renamed";
      },
    ],
    [
      "corrupted severity",
      (contract: { checks: { severity: string }[] }) => {
        contract.checks[0].severity = "warning";
      },
    ],
  ])("rejects a %s 0.22.0 checks table", (_case, mutate) => {
    const contract = fixture("contract.json") as {
      checks: { id: string; name: string; severity: string }[];
    };
    mutate(contract);
    expect(ContractSchema.safeParse(contract).success).toBe(false);
  });

  it("the conditional-companion refusal is a structured error (the review names a task, no --task handed)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-missing-task.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/missing --task/);
    }
  });

  it("--spec on an artifact that is neither a task nor a review is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-companions-without-review.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/task paths or one review/);
    }
  });

  it("a handed companion path missing on disk is a structured error (file not found)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-companion-not-found.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/--spec file not found/);
    }
  });

  it("a review checked with NO --spec at all is a structured error (missing --spec)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-missing-spec.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/missing --spec/);
    }
  });

  it("a --task handed to a review that references none is a structured error (a companion nothing references)", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-task-not-referenced.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/companion nothing references/);
    }
  });

  it("malformed task companions are structured errors", () => {
    const cases = [
      ["error-task-wrong-type.json", /fails deterministic checks: C022/],
      ["error-task-empty-scope.json", /fails deterministic checks: C022/],
      ["error-task-wrong-source.json", /does not name handed spec/],
    ] as const;
    for (const [name, message] of cases) {
      const parsed = SuspecErrorSchema.safeParse(fixture(name));
      expect(parsed.success, name).toBe(true);
      if (parsed.success) expect(parsed.data.message).toMatch(message);
    }
  });

  it("a non-spec --spec companion is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-spec-wrong-type.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/fails deterministic checks: .*C025/);
    }
  });

  it("a list-shaped review task ref is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-review-task-list.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(
        /frontmatter `task:` must be a scalar/,
      );
    }
  });

  it("a quoted BOM-prefixed review with no spec is a structured error", () => {
    const parsed = SuspecErrorSchema.safeParse(
      fixture("error-quoted-bom-missing-spec.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.message).toMatch(/missing --spec/);
  });

  it("the tripwire FAILS if a consumed field is renamed/dropped (a diagnostic's message; the contract's checks)", () => {
    const report = JSON.parse(
      readFileSync(
        join(here, "fixtures", "check-review-diagnostics.json"),
        "utf8",
      ),
    );
    delete report.diagnostics[0].message;
    expect(CheckReportSchema.safeParse(report).success).toBe(false);

    const contract = JSON.parse(
      readFileSync(join(here, "fixtures", "contract.json"), "utf8"),
    );
    delete contract.checks;
    expect(ContractSchema.safeParse(contract).success).toBe(false);
  });

  it("the runtime line schema accepts reports and structured errors but rejects unknown documents", () => {
    expect(CheckLineSchema.safeParse(fixture("check-spec.json")).success).toBe(
      true,
    );
    expect(
      CheckLineSchema.safeParse(fixture("error-missing-spec.json")).success,
    ).toBe(true);
    expect(CheckLineSchema.safeParse({ malformed: true }).success).toBe(false);
  });

  it("rejects unknown report levels and diagnostic severities", () => {
    const report = JSON.parse(
      readFileSync(
        join(here, "fixtures", "check-review-diagnostics.json"),
        "utf8",
      ),
    );
    report.level = "a-new-level-class";
    report.diagnostics[0].severity = "a-new-severity-class";
    expect(CheckReportSchema.safeParse(report).success).toBe(false);

    report.level = "blocking";
    expect(CheckReportSchema.safeParse(report).success).toBe(false);
    report.diagnostics[0].severity = "hard-error";
    expect(CheckReportSchema.safeParse(report).success).toBe(false);
    report.diagnostics[0].message =
      "coverage row AC-001's verify block records a cmd that does not match the requirement's named Verify command";
    expect(CheckReportSchema.safeParse(report).success).toBe(true);
  });

  it("binds diagnostic codes, severities, and report levels to the supported checks table", () => {
    const diagnostic = {
      code: "C021",
      severity: "warning",
      message: "intent missing",
      line: null,
    };
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "warning",
        path: "spec.md",
        diagnostics: [diagnostic],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "warning",
        path: "spec.md",
        diagnostics: [{ ...diagnostic, code: "C999" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "review",
        level: "blocking",
        path: "review.md",
        diagnostics: [
          {
            ...diagnostic,
            code: "C013",
            severity: "hard-error",
            message:
              "coverage row AC-001's verify block records a cmd that does not match the requirement's named Verify command",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      CheckReportSchema.safeParse({
        type: "review",
        level: "blocking",
        path: "review.md",
        diagnostics: [
          {
            ...diagnostic,
            code: "C013",
            severity: "hard-error",
            message:
              "coverage row AC-001 is Supported with only a free-form Evidence cell",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "clean",
        path: "spec.md",
        diagnostics: [{ ...diagnostic, code: "C004" }],
      }).success,
    ).toBe(false);
    expect(
      CheckReportSchema.safeParse({
        type: "spec",
        level: "blocking",
        path: "spec.md",
        diagnostics: [],
      }).success,
    ).toBe(false);
  });
});

describe("the test stub conforms to the SAME contract as the real captured output", () => {
  it("stub check <spec> output parses against CheckReportSchema (exit 1: a warning report)", () => {
    const { data, exit } = runStub(["check", "spec.md"]);
    expect(CheckReportSchema.safeParse(data).success).toBe(true);
    expect(exit).toBe(1);
  });

  it("stub check <review> with both companions parses clean (exit 0)", () => {
    const { data, exit } = runStub([
      "check",
      "review.md",
      "--spec",
      "spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = CheckReportSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("clean");
    }
    expect(exit).toBe(0);
  });

  it("stub check <task-less review> with only --spec parses clean (exit 0) — the spec-keyed check", () => {
    const { data, exit } = runStub([
      "check",
      "review-notask.md",
      "--spec",
      "spec.md",
    ]);
    const parsed = CheckReportSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.level).toBe("clean");
    }
    expect(exit).toBe(0);
  });

  it("stub check on a no-check-face type parses against UncheckedArtifactSchema (exit 0)", () => {
    const { data, exit } = runStub(["check", "audit.md"]);
    expect(UncheckedArtifactSchema.safeParse(data).success).toBe(true);
    expect(exit).toBe(0);
  });

  it("stub check --contract parses against ContractSchema", () => {
    const { data } = runStub(["check", "--contract"]);
    expect(ContractSchema.safeParse(data).success).toBe(true);
  });

  it("stub refuses a task-referencing review without --task exactly like the real CLI (exit 2, same message shape)", () => {
    const { data, exit } = runStub(["check", "review.md", "--spec", "spec.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/missing --task/);
      // the same message shape the real capture pinned
      const real = SuspecErrorSchema.parse(fixture("error-missing-task.json"));
      expect(parsed.data.message).toMatch(/the review names task `TASK-x`/);
      expect(real.message).toMatch(/the review names task `TASK-demo`/);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses --spec on an artifact that is neither a task nor a review exactly like the real CLI", () => {
    const { data, exit } = runStub(["check", "spec.md", "--spec", "spec.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const real = SuspecErrorSchema.parse(
        fixture("error-companions-without-review.json"),
      );
      expect(parsed.data.message).toBe(real.message);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a review checked with NO --spec exactly like the real CLI (exit 2, same message)", () => {
    const { data, exit } = runStub(["check", "review.md"]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const real = SuspecErrorSchema.parse(fixture("error-missing-spec.json"));
      expect(parsed.data.message).toBe(real.message);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a --task handed to a task-less review exactly like the real CLI (exit 2, same message)", () => {
    const { data, exit } = runStub([
      "check",
      "review-notask.md",
      "--spec",
      "spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const real = SuspecErrorSchema.parse(
        fixture("error-task-not-referenced.json"),
      );
      expect(parsed.data.message).toBe(real.message);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses a companion path missing on disk exactly like the real CLI (exit 2, same message shape)", () => {
    const { data, exit } = runStub([
      "check",
      "review.md",
      "--spec",
      "no-such-spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = SuspecErrorSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe(
        "--spec file not found: no-such-spec.md",
      );
      const real = SuspecErrorSchema.parse(
        fixture("error-companion-not-found.json"),
      );
      expect(real.message).toMatch(/--spec file not found/);
    }
    expect(exit).toBe(2);
  });

  it("stub refuses malformed task companions like the real CLI", () => {
    const cases = [
      ["not-a-task.md", "error-task-wrong-type.json"],
      ["scope-less-task.md", "error-task-empty-scope.json"],
      ["wrong-source-task.md", "error-task-wrong-source.json"],
    ] as const;
    for (const [task, fixtureName] of cases) {
      const { data, exit } = runStub([
        "check",
        "review.md",
        "--spec",
        "spec.md",
        "--task",
        task,
      ]);
      const parsed = SuspecErrorSchema.parse(data);
      const real = SuspecErrorSchema.parse(fixture(fixtureName));
      expect(parsed.message.replaceAll("SPEC-x", "SPEC-demo-feature")).toBe(
        real.message,
      );
      expect(exit).toBe(2);
    }
  }, 15_000);

  it("stub refuses a non-spec --spec companion like the real CLI", () => {
    const { data, exit } = runStub([
      "check",
      "review.md",
      "--spec",
      "not-a-spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(fixture("error-spec-wrong-type.json"));
    expect(parsed.message).toBe(real.message);
    expect(exit).toBe(2);
  });

  it("stub refuses a list-shaped review task ref like the real CLI", () => {
    const { data, exit } = runStub([
      "check",
      "review-task-list.md",
      "--spec",
      "spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(
      fixture("error-review-task-list.json"),
    );
    expect(parsed.message).toBe(real.message);
    expect(exit).toBe(2);
  });

  it("stub emits the real C020 shape for a mismatched task companion", () => {
    const { data, exit } = runStub([
      "check",
      "review-task-mismatch.md",
      "--spec",
      "spec.md",
      "--task",
      "task.md",
    ]);
    const parsed = CheckReportSchema.parse(data);
    const real = CheckReportSchema.parse(
      fixture("check-review-task-mismatch.json"),
    );
    expect(parsed.level).toBe(real.level);
    expect(
      parsed.diagnostics.map((item) => ({
        ...item,
        message: item.message.replaceAll("TASK-x", "TASK-demo"),
      })),
    ).toEqual(real.diagnostics);
    expect(exit).toBe(2);
  });

  it("stub recognizes a quoted BOM-prefixed review like the real CLI", () => {
    const { data, exit } = runStub(["check", "review-quoted-bom.md"]);
    const parsed = SuspecErrorSchema.parse(data);
    const real = SuspecErrorSchema.parse(
      fixture("error-quoted-bom-missing-spec.json"),
    );
    expect(parsed.message).toBe(real.message);
    expect(exit).toBe(2);
  });
});
