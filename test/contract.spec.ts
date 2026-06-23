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
  CorpusErrorSchema,
} from "../src/corpus/contract.ts";

// The DRIFT TRIPWIRE has two halves that together pin stub → contract → reality:
//   (1) the captured fixtures were recorded from the REAL `corpus … --json` (the corpus-hq workspace —
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

  it("check <file> --json → FileCheck", () => {
    expect(FileCheckSchema.safeParse(fixture("check-file.json")).success).toBe(
      true,
    );
  });

  it("review --json → ReviewReport (the consumed shape)", () => {
    const parsed = ReviewReportSchema.safeParse(fixture("review-report.json"));
    expect(parsed.success).toBe(true);
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

  it("the tripwire FAILS on a closed-set enum drift (a new coverage kind)", () => {
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    drifted.coverage = [{ id: "AC-001", kind: "something-new", message: "x" }];
    expect(ReviewReportSchema.safeParse(drifted).success).toBe(false);
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
});
