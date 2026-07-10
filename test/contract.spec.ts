import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CheckReportSchema,
  UncheckedArtifactSchema,
  CheckFileSchema,
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
      "---\ntype: task\nid: TASK-x\nscope: [AC-001]\n---\n",
    );
    writeFileSync(
      join(dir, "review.md"),
      "---\ntype: review\nid: REVIEW-x\ntask: TASK-x\n---\n\n## Requirement coverage\n",
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

  it("a diagnostic-carrying review report pins the diagnostic fields (code/severity/message/line)", () => {
    const parsed = CheckReportSchema.safeParse(
      fixture("check-review-diagnostics.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // the real capture carries the empty-evidence Pass row's diagnostics — a genuine finding
      expect(parsed.data.diagnostics.length).toBeGreaterThan(0);
      expect(parsed.data.diagnostics.map((d) => d.code)).toContain("C016");
      expect(parsed.data.level).toBe("blocking");
    }
  });

  it("check on an artifact type with no check face → UncheckedArtifact (checked:false, exit-0 shape)", () => {
    const parsed = UncheckedArtifactSchema.safeParse(
      fixture("check-unchecked.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("task");
      expect(parsed.data.checked).toBe(false);
    }
  });

  it("every check capture parses under the CheckFile union", () => {
    for (const name of [
      "check-spec.json",
      "check-review.json",
      "check-review-diagnostics.json",
      "check-unchecked.json",
    ]) {
      expect(
        CheckFileSchema.safeParse(fixture(name)).success,
        `${name} must parse as a CheckFile`,
      ).toBe(true);
    }
  });

  it("check --contract --json → Contract (version + the core checks)", () => {
    const parsed = ContractSchema.safeParse(fixture("contract.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(parsed.data.checks.length).toBeGreaterThan(0);
      for (const check of parsed.data.checks) {
        expect(check.id).toMatch(/^C\d{3}$/);
      }
    }
  });

  it("the conditional-companion refusal is a structured error (the review names a task, no --task handed)", () => {
    const parsed = SuspecErrorSchema.safeParse(fixture("error-missing-task.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toMatch(/missing --task/);
    }
  });

  it("the tripwire FAILS if a consumed field is renamed/dropped (a diagnostic's message; the contract's checks)", () => {
    const report = JSON.parse(
      readFileSync(join(here, "fixtures", "check-review-diagnostics.json"), "utf8"),
    );
    delete report.diagnostics[0].message;
    expect(CheckReportSchema.safeParse(report).success).toBe(false);

    const contract = JSON.parse(
      readFileSync(join(here, "fixtures", "contract.json"), "utf8"),
    );
    delete contract.checks;
    expect(ContractSchema.safeParse(contract).success).toBe(false);
  });

  it("a diagnostic's `severity` and a report's `level` are PASS-THROUGH: a new CLI value does NOT trip the wire", () => {
    // The adapter branches on NO payload enum — it relays these fields — so a benign additive CLI
    // value class must parse (the enum policy in contract.ts).
    const report = JSON.parse(
      readFileSync(join(here, "fixtures", "check-review-diagnostics.json"), "utf8"),
    );
    report.level = "a-new-level-class";
    report.diagnostics[0].severity = "a-new-severity-class";
    expect(CheckReportSchema.safeParse(report).success).toBe(true);
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

  it("stub check on a no-check-face type parses against UncheckedArtifactSchema (exit 0)", () => {
    const { data, exit } = runStub(["check", "task.md"]);
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
});
