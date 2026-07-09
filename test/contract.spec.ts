import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StoreStatusSchema,
  StoreListSchema,
  StoreLintSchema,
  FileCheckSchema,
  RunReviewSchema,
  ShowChecksSchema,
  WriteSpecSchema,
  CutTaskSchema,
  SuspecErrorSchema,
} from "../src/suspec/contract.ts";

// The DRIFT TRIPWIRE has two halves that together pin stub → contract → reality:
//   (1) the captured fixtures were recorded from the REAL `suspec … --json` (a scratch repo + store —
//       note the absolute paths). Parsing them proves the CONTRACT matches reality; a suspec-cli rename
//       or dropped field fails the parse here instead of the adapter silently producing wrong output.
//   (2) the test STUB (the binary the integration tests run against) is parsed through the SAME schemas,
//       so the stub cannot drift from the contract the fixtures define — closing the gap where the stub,
//       the fixtures, and the CLI were three separate truths and the tests stayed green on a divergence.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
const stubBin = join(here, "fixtures", "stub-suspec.mjs");
const runStub = (args: string[]): unknown =>
  JSON.parse(
    spawnSync(stubBin, [...args, "--json"], { encoding: "utf8" }).stdout.trim(),
  );

describe("the contract matches the real --json shapes (captured fixtures)", () => {
  it("status --json → StoreStatus (active/archived listings + the `next` ranking)", () => {
    const parsed = StoreStatusSchema.safeParse(fixture("status.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.active.length).toBeGreaterThan(0);
      expect(Array.isArray(parsed.data.archived)).toBe(true);
      expect(parsed.data.next.length).toBeGreaterThan(0);
    }
  });

  it("store list --json → StoreList (store path + counts + listings)", () => {
    const parsed = StoreListSchema.safeParse(fixture("store-list.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.store.length).toBeGreaterThan(0);
      expect(parsed.data.active_count).toBe(parsed.data.active.length);
    }
  });

  it("check --json (no args, the store lint) → StoreLint", () => {
    const parsed = StoreLintSchema.safeParse(fixture("check-store.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.artifacts.length).toBeGreaterThan(0);
    }
  });

  it("check <file> --json → FileCheck", () => {
    expect(FileCheckSchema.safeParse(fixture("check-file.json")).success).toBe(
      true,
    );
  });

  it("review <RUN> --json → RunReview (lint + evidence rows + gaps — the consumed shape)", () => {
    const parsed = RunReviewSchema.safeParse(fixture("review-report.json"));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // the real capture carries a verified row AND a missing row (a genuine gate gap)
      const statuses = parsed.data.evidence.map((r) => r.status);
      expect(statuses).toContain("verified");
      expect(statuses).toContain("missing");
      expect(parsed.data.gaps).toContain("AC-002");
    }
  });

  it("show checks --json → ShowChecks", () => {
    expect(ShowChecksSchema.safeParse(fixture("show-checks.json")).success).toBe(
      true,
    );
  });

  it("the SAFE-WRITE tier reports parse: write spec / new task --from", () => {
    const spec = WriteSpecSchema.safeParse(fixture("write-spec.json"));
    expect(spec.success).toBe(true);
    if (spec.success) {
      // the report relays the artifact identity the adapter surfaces — never a verdict; and the
      // adapter never passes --launch, so the captured scaffold is undispatched.
      expect(spec.data.spec).toMatch(/^SPEC-/);
      expect(spec.data.launched).toBe(false);
    }
    const task = CutTaskSchema.safeParse(fixture("new-task.json"));
    expect(task.success).toBe(true);
    if (task.success) {
      expect(task.data.taskId).toMatch(/^TASK-/);
      expect(task.data.specId).toMatch(/^SPEC-/);
    }
  });

  it("the structured error body parses", () => {
    expect(
      SuspecErrorSchema.safeParse({
        error: "store_run_not_found",
        message: "no run x in the store",
      }).success,
    ).toBe(true);
  });

  it("an evidence-row `status` is PASS-THROUGH: a new CLI status value does NOT trip the wire (AC-011)", () => {
    const base = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    // AC-011: the adapter derives human-attention from `gaps` + diagnostics, never branching on an
    // evidence row's status — a new CLI status class is a benign additive change that must parse.
    base.evidence[0].status = "verified-agent-with-a-new-label";
    expect(RunReviewSchema.safeParse(base).success).toBe(true);
  });

  it("the tripwire FAILS if a consumed field is renamed/dropped (a lint diagnostic's message)", () => {
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    drifted.lint = [
      {
        path: "spec-x.md",
        diagnostics: [{ check: "C007", severity: "hard-error" /* message dropped */ }],
      },
    ];
    expect(RunReviewSchema.safeParse(drifted).success).toBe(false);
  });

  it("the tripwire FAILS on a lint severity outside the branched value-set (the one closed enum)", () => {
    // The adapter BRANCHES on `severity === "hard-error"` (envelope.ts), so a new severity class the
    // adapter cannot interpret must trip the wire, per the enum policy.
    const drifted = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    drifted.lint = [
      {
        path: "spec-x.md",
        diagnostics: [{ check: "C007", severity: "catastrophic", message: "x" }],
      },
    ];
    expect(RunReviewSchema.safeParse(drifted).success).toBe(false);
  });

  it("the tripwire FAILS if a required top-level list is dropped (review.gaps / status.next)", () => {
    const review = JSON.parse(
      readFileSync(join(here, "fixtures", "review-report.json"), "utf8"),
    );
    delete review.gaps;
    expect(RunReviewSchema.safeParse(review).success).toBe(false);
    const status = JSON.parse(
      readFileSync(join(here, "fixtures", "status.json"), "utf8"),
    );
    delete status.next;
    expect(StoreStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe("the test stub conforms to the SAME contract as the real captured output", () => {
  it("stub status output parses against StoreStatusSchema", () => {
    expect(StoreStatusSchema.safeParse(runStub(["status"])).success).toBe(true);
  });

  it("stub store list output parses against StoreListSchema", () => {
    expect(
      StoreListSchema.safeParse(runStub(["store", "list"])).success,
    ).toBe(true);
  });

  it("stub check (store lint) output parses against StoreLintSchema", () => {
    expect(StoreLintSchema.safeParse(runStub(["check"])).success).toBe(true);
  });

  it("stub check <file> output parses against FileCheckSchema", () => {
    expect(
      FileCheckSchema.safeParse(runStub(["check", "specs/a/spec.md"])).success,
    ).toBe(true);
  });

  it("stub review output parses against RunReviewSchema, and carries the same gap shape as the real capture", () => {
    const stub = RunReviewSchema.parse(runStub(["review", "feat"]));
    const real = RunReviewSchema.parse(fixture("review-report.json"));
    // The schema cannot see list SEMANTICS, so pin them directly: both surface at least one gap whose
    // AC id also appears as a `missing` evidence row (the done-gate preview the adapter derives from).
    for (const report of [stub, real]) {
      expect(report.gaps.length).toBeGreaterThan(0);
      const gapped = report.evidence.find((r) => r.ac === report.gaps[0]);
      expect(gapped?.status).toBe("missing");
    }
  });

  it("stub show checks / write spec / new task outputs parse against their schemas", () => {
    expect(ShowChecksSchema.safeParse(runStub(["show", "checks"])).success).toBe(
      true,
    );
    expect(
      WriteSpecSchema.safeParse(runStub(["write", "spec", "demo feature"]))
        .success,
    ).toBe(true);
    expect(
      CutTaskSchema.safeParse(
        runStub(["new", "task", "--from", "SPEC-x", "--scope", "AC-001"]),
      ).success,
    ).toBe(true);
  });
});
