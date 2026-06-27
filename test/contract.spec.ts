import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DerivedBoardSchema,
  WorkspaceCheckSchema,
  FileCheckSchema,
  ReviewReportSchema,
  ShowChecksSchema,
  ShowTaskSchema,
  ShowSpecSchema,
  ShowReviewSchema,
  ScaffoldSpecSchema,
  CutPacketSchema,
  ScaffoldFindingSchema,
  CorpusErrorSchema,
} from "../src/corpus/contract.ts";

// The DRIFT TRIPWIRE has two halves that together pin stub → contract → reality:
//   (1) the captured fixtures were recorded from the REAL `corpus … --json` (the corpus-works workspace —
//       note the absolute paths). Parsing them proves the CONTRACT matches reality; a corpus-cli rename
//       or dropped field fails the parse here instead of the adapter silently producing wrong output.
//   (2) the test STUB (the binary the integration tests run against) is parsed through the SAME schemas,
//       so the stub cannot drift from the contract the fixtures define — closing the gap where the stub,
//       the fixtures, and the CLI were three separate truths and the tests stayed green on a divergence.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const stubBin = join(here, "fixtures", "stub-corpus.mjs");
const runStub = (args: string[]): unknown =>
  JSON.parse(
    spawnSync(stubBin, [...args, "--json"], { encoding: "utf8" }).stdout.trim(),
  );

describe("the contract matches the real --json shapes (captured fixtures)", () => {
  it("status --json → DerivedBoard (incl. tasksWithoutReview / needsHuman)", () => {
    const parsed = DerivedBoardSchema.safeParse(fixture("status.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.specs.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.data.tasksWithoutReview)).toBe(true);
      expect(Array.isArray(parsed.data.needsHuman)).toBe(true);
    }
  });

  it("check --json (workspace) → WorkspaceCheck (incl. verdict / changePlans / workspaceFindings)", () => {
    const parsed = WorkspaceCheckSchema.safeParse(
      fixture("check-workspace.json"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBeDefined();
      expect(Array.isArray(parsed.data.changePlans)).toBe(true);
      expect(Array.isArray(parsed.data.workspaceFindings)).toBe(true);
    }
  });

  it("WorkspaceFinding.code is PASS-THROUGH: a benign new CLI advisory code does NOT trip the wire (AC-011/F7)", () => {
    const withFinding = (code: string) => ({
      level: "warning",
      verdict: "clean",
      specs: [],
      changePlans: [],
      workspaceFindings: [{ code, message: "x" }],
    });
    // An existing advisory code parses (unchanged behaviour for the consumer).
    expect(
      WorkspaceCheckSchema.safeParse(withFinding("incomplete-execution-digest"))
        .success,
    ).toBe(true);
    // AC-011: the adapter only PASSES `code` through (it surfaces the message, never branches on the
    // code), so a new CLI advisory code is a benign additive change that must NOT convert into a
    // corpus-mcp break — it parses, where the old closed enum would have tripped.
    expect(
      WorkspaceCheckSchema.safeParse(withFinding("totally-new-code")).success,
    ).toBe(true);
    // The tripwire that DOES still fire: the adapter reads `message`, so dropping it trips the wire.
    expect(
      WorkspaceCheckSchema.safeParse({
        level: "warning",
        verdict: "clean",
        specs: [],
        changePlans: [],
        workspaceFindings: [{ code: "C002" /* message dropped */ }],
      }).success,
    ).toBe(false);
  });

  it("check <file> --json → FileCheck", () => {
    expect(FileCheckSchema.safeParse(fixture("check-file.json")).success).toBe(
      true,
    );
  });

  it("review --json → ReviewReport (the consumed shape)", () => {
    const parsed = ReviewReportSchema.safeParse(fixture("review-report.json"));
    expect(parsed.success).toBe(true);
  });

  it("show checks --json → ShowChecks", () => {
    expect(ShowChecksSchema.safeParse(fixture("show-checks.json")).success).toBe(
      true,
    );
  });

  it("show task --json → ShowTask (incl. the cross-root embedded slice fields)", () => {
    const parsed = ShowTaskSchema.safeParse(fixture("show-task.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("embeddedSpecId" in parsed.data.value).toBe(true);
      expect(Array.isArray(parsed.data.value.embeddedRequirements)).toBe(true);
    }
  });

  it("show spec --json → ShowSpec (incl. the `## Execution` run-record field)", () => {
    const parsed = ShowSpecSchema.safeParse(fixture("show-spec.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("execution" in parsed.data.value).toBe(true);
    }
  });

  it("show review --json → ShowReview (incl. the identity/staleness frontmatter)", () => {
    const parsed = ShowReviewSchema.safeParse(fixture("show-review.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("reviewedSha" in parsed.data.value.frontmatter).toBe(true);
      expect("evidenceHash" in parsed.data.value.frontmatter).toBe(true);
    }
  });

  it("the show tripwire FAILS if review frontmatter drops a staleness pin (evidenceHash)", () => {
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "show-review.json"), "utf8"),
    );
    delete drifted.value.frontmatter.evidenceHash;
    expect(ShowReviewSchema.safeParse(drifted).success).toBe(false);
  });

  it("the SAFE-WRITE tier reports parse (AC-009): new spec / new task --from / promote", () => {
    expect(ScaffoldSpecSchema.safeParse(fixture("new-spec.json")).success).toBe(
      true,
    );
    expect(CutPacketSchema.safeParse(fixture("new-task.json")).success).toBe(
      true,
    );
    const promote = ScaffoldFindingSchema.safeParse(fixture("promote.json"));
    expect(promote.success).toBe(true);
    if (promote.success) {
      // the report relays the artifact identity the adapter surfaces (path/slug/from) — never a verdict.
      expect(promote.data.slug.length).toBeGreaterThan(0);
      expect(promote.data.from.length).toBeGreaterThan(0);
    }
  });

  it("the structured error body parses", () => {
    expect(
      CorpusErrorSchema.safeParse({
        error: "Usage",
        message: "no worktree found",
      }).success,
    ).toBe(true);
  });

  it("a board task with reviewStatus:null parses (the unreviewed-task case)", () => {
    const board = {
      level: "clean",
      specs: [
        {
          id: "S",
          status: "ready",
          tasks: [
            { id: "T", status: "ready", hasReview: false, reviewStatus: null },
          ],
        },
      ],
      tasksWithoutReview: ["T"],
      needsHuman: [],
    };
    expect(DerivedBoardSchema.safeParse(board).success).toBe(true);
  });

  it("the tripwire FAILS if a consumed field is renamed/dropped (verifyBinding.message)", () => {
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    drifted.verifyBinding = [
      { id: "AC-001", kind: "cmd-mismatch" /* message dropped */ },
    ];
    expect(ReviewReportSchema.safeParse(drifted).success).toBe(false);
  });

  it("a new coverage `kind` is PASS-THROUGH and does NOT trip the wire (AC-011); the consumed `message` still does", () => {
    const base = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    // AC-011: the adapter derives human-attention from `.message`/`.id` and never branches on `kind`, so
    // a new CLI coverage kind is a benign additive change that must NOT break corpus-mcp (it parses).
    const newKind = { ...base };
    newKind.coverage = [{ id: "AC-001", kind: "something-new", message: "x" }];
    expect(ReviewReportSchema.safeParse(newKind).success).toBe(true);
    // The tripwire that DOES still fire: dropping `message` (which the adapter reads) trips the wire.
    const droppedMessage = { ...base };
    droppedMessage.coverage = [{ id: "AC-001", kind: "uncovered" }];
    expect(ReviewReportSchema.safeParse(droppedMessage).success).toBe(false);
  });

  it("the tripwire FAILS if a required top-level list is dropped (status.tasksWithoutReview)", () => {
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "status.json"), "utf8"),
    );
    delete drifted.tasksWithoutReview;
    expect(DerivedBoardSchema.safeParse(drifted).success).toBe(false);
  });
});

describe("the test stub conforms to the SAME contract as the real captured output", () => {
  it("stub status output parses against DerivedBoardSchema", () => {
    expect(DerivedBoardSchema.safeParse(runStub(["status"])).success).toBe(
      true,
    );
  });

  it("stub check (workspace) output parses against WorkspaceCheckSchema", () => {
    expect(WorkspaceCheckSchema.safeParse(runStub(["check"])).success).toBe(
      true,
    );
  });

  it("stub check <file> output parses against FileCheckSchema", () => {
    expect(
      FileCheckSchema.safeParse(runStub(["check", "specs/a/spec.md"])).success,
    ).toBe(true);
  });

  it("stub review output parses against ReviewReportSchema, and its coverage wording matches the real capture", () => {
    const stub = ReviewReportSchema.parse(runStub(["review", "feat"]));
    const real = ReviewReportSchema.parse(fixture("review-report.json"));
    // The schema cannot see message WORDING (it is just a string), so pin it directly: the stub's
    // coverage message must carry the same `(uncovered)` kind suffix the real CLI single-sources.
    expect(stub.coverage[0].message).toMatch(/\(uncovered\)$/);
    expect(real.coverage[0].message).toMatch(/\(uncovered\)$/);
  });

  it("stub show checks/task/spec/review output parses against the Show schemas", () => {
    expect(ShowChecksSchema.safeParse(runStub(["show", "checks"])).success).toBe(
      true,
    );
    expect(
      ShowTaskSchema.safeParse(runStub(["show", "task", "feat"])).success,
    ).toBe(true);
    expect(
      ShowSpecSchema.safeParse(runStub(["show", "spec", "SPEC-feat"])).success,
    ).toBe(true);
    expect(
      ShowReviewSchema.safeParse(runStub(["show", "review", "feat"])).success,
    ).toBe(true);
  });
});
