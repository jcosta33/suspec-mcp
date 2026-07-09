#!/usr/bin/env node
// A stub `suspec` binary for deterministic, offline suspec-mcp tests — the v2 STORE surface. Records
// every invocation's argv to STUB_LOG (so tests can assert which subprocesses ran / that no write flag
// was ever passed) and emits fixture JSON to stdout keyed off the verb — mirroring the real CLI's
// --json shapes. The safe-write verbs write their scaffold into STUB_STORE (a stand-in for the
// user-level store, OUTSIDE the workspace) when that env var is set — never into cwd (the repo).
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.STUB_LOG) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
}
// Make the no-write test non-circular: if a write/mutation/dispatch flag is EVER passed, drop a marker
// into the workspace (cwd). The test then asserts the marker never appears — a real failure if the
// adapter leaks such a flag, not a tautology about a non-writing stub.
if (
  argv.some(
    (a) => a === "--write" || a === "--force" || a === "--agent" || a === "--launch",
  )
) {
  appendFileSync(join(process.cwd(), "WRITE-FLAG-SEEN"), "1");
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj));
const verb = argv[0];
const positionals = argv.slice(1).filter((a) => !a.startsWith("--"));
// The stand-in store dir (outside the workspace). Path strings are emitted either way; files are
// written only when STUB_STORE is set.
const store = process.env.STUB_STORE ?? "/stub/store";
const inStore = (name, content) => {
  if (process.env.STUB_STORE) {
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, name), content);
  }
  return join(store, name);
};

const ACTIVE = [
  { filename: "spec-x.md", kind: "spec", ageDays: 0 },
  { filename: "run-feat.md", kind: "run", ageDays: 1 },
];
const ARCHIVED = [{ filename: "run-old.md", kind: "run", ageDays: 44 }];
const NEXT = [
  {
    rank: 3,
    kind: "gate-gaps",
    ref: "feat",
    detail: "run feat finished but 1 AC(s) lack exit-0 evidence (AC-002)",
    action:
      "capture it: suspec evidence add feat --ac <AC> -- <command>, then suspec done feat",
  },
];

if (verb === "status") {
  emit({ level: "clean", active: ACTIVE, archived: ARCHIVED, next: NEXT });
} else if (verb === "store" && positionals[0] === "list") {
  emit({
    level: "clean",
    store,
    active_count: ACTIVE.length,
    archived_count: ARCHIVED.length,
    active: ACTIVE,
    archived: ARCHIVED,
  });
} else if (verb === "check") {
  const path = positionals[0];
  if (path) {
    emit({
      level: "warning",
      path,
      diagnostics: [
        { code: "C004", severity: "warning", message: "demo", line: 1 },
      ],
    });
  } else {
    // The store lint (v2 `check` with no args) — one clean artifact + one carrying a diagnostic.
    emit({
      level: "warning",
      runCount: 1,
      specCount: 1,
      artifacts: [
        { path: join(store, "spec-x.md"), diagnostics: [] },
        {
          path: join(store, "run-feat.md"),
          diagnostics: [
            {
              check: "RUN01",
              severity: "warning",
              message: "run record missing a worktree field",
            },
          ],
        },
      ],
    });
  }
} else if (verb === "review") {
  const slug = positionals[0];
  if (slug === "norun") {
    process.stdout.write(
      JSON.stringify({
        error: "store_run_not_found",
        message: `no run ${slug} in the store (searched ${join(store, `run-${slug}.md`)})`,
      }),
    );
    process.exit(2);
  }
  // The v2 run-vs-spec reconcile: artifact lint (one hard-error) + evidence rows (one verified, one
  // missing) + the gate gaps — the same rows `suspec done` gates on.
  emit({
    level: "blocking",
    runSlug: slug,
    specId: "SPEC-x",
    lint: [
      { path: join(store, `run-${slug}.md`), diagnostics: [] },
      {
        path: join(store, "spec-x.md"),
        diagnostics: [
          {
            check: "C007",
            severity: "hard-error",
            message: "spec has {{TBD}} placeholders at status ready",
          },
        ],
      },
    ],
    evidence: [
      {
        ac: "AC-001",
        command: "pnpm test",
        exit: 0,
        evidenceRef: "001-pnpm-test.md",
        provenance: "cli-verified",
        status: "verified",
      },
      {
        ac: "AC-002",
        command: "`second test`",
        exit: null,
        evidenceRef: null,
        provenance: null,
        status: "missing",
      },
    ],
    gaps: ["AC-002"],
  });
} else if (verb === "show" && positionals[0] === "checks") {
  emit({
    level: "clean",
    kind: "checks",
    value: {
      version: "0.15.0",
      checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
    },
  });
} else if (verb === "show") {
  // The store-resolving loader face: `show <kind> <ref>` → ShowResult {level:'clean', kind, value}.
  // Mirrors the real CLI's per-kind projections (showArtifact.ts): spec/task/review parsed records,
  // run/intake the frontmatter+body split, finding its severity/areas/body. Unknown ref → the CLI's
  // structured exit-2 error.
  const kind = positionals[0];
  const ref = positionals[1];
  const KINDS = new Set(["spec", "run", "review", "task", "finding", "intake"]);
  if (!KINDS.has(kind) || !ref) {
    process.stdout.write(
      JSON.stringify({ error: "Usage", message: `usage: suspec show <kind> <id|slug>` }),
    );
    process.exit(2);
  }
  if (ref === "ghost") {
    process.stdout.write(
      JSON.stringify({
        error: "Usage",
        message: `cannot resolve ${kind}: ${ref} (looked for ${kind}-*.md in ${store}, archive/ included)`,
      }),
    );
    process.exit(2);
  }
  const VALUES = {
    spec: {
      frontmatter: { type: "spec", id: "SPEC-x", status: "ready" },
      requirements: [{ id: "AC-001", line: 14, verifyCommand: "pnpm test" }],
      sectionTitles: ["Intent", "Requirements"],
      openQuestionsPresent: false,
      malformedRequirementHeadings: [],
      execution: null,
    },
    run: {
      path: join(store, `run-${ref}.md`),
      archived: false,
      frontmatter: { type: "run", spec: "SPEC-x", status: "exited" },
      body: "# Run\n\nagent notes",
    },
    review: {
      status: "draft",
      sectionTitles: ["Requirement coverage"],
      coverageRows: [{ id: "AC-001", result: "Pass", evidence: "pnpm test → 0" }],
      verifyBlocks: [],
      frontmatter: {
        status: "draft",
        spec: "SPEC-x",
        run: "feat",
        task: null,
        pr: null,
        reviewedSha: null,
        evidenceHash: null,
      },
    },
    task: {
      id: "TASK-x",
      source: "SPEC-x",
      status: "todo",
      scope: ["AC-001"],
      affectedAreas: [],
      doNotChange: [],
      claimedChangedFiles: [],
      embeddedSpecId: null,
      embeddedRequirements: [],
    },
    finding: {
      path: join(store, `finding-${ref}.md`),
      archived: false,
      id: "FINDING-x",
      title: "a finding",
      severity: "medium",
      run: "feat",
      affectedAreas: ["src/a.ts"],
      body: "the lesson",
    },
    intake: {
      path: join(store, `intake-${ref}.md`),
      archived: false,
      frontmatter: { type: "intake" },
      body: "raw intake note",
    },
  };
  emit({ level: "clean", kind, value: VALUES[kind] });
} else if (verb === "write" && positionals[0] === "spec") {
  // `write spec "<intent>"` — the ONE spec scaffold, store-rooted. Slugs the intent like the CLI.
  const intent = positionals[1];
  if (!intent) {
    process.stdout.write(
      JSON.stringify({ error: "Usage", message: "write spec needs an intent" }),
    );
    process.exit(2);
  }
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const spec_path = inStore(
    `spec-${slug}.md`,
    `---\ntype: spec\nid: SPEC-${slug}\nstatus: draft\n---\n\n${intent}\n`,
  );
  emit({
    level: "clean",
    spec: `SPEC-${slug}`,
    spec_path,
    created: true,
    launched: false,
  });
} else if (verb === "new") {
  // `new task --from <SPEC> [--scope …]` — the store task slice (scope copied, never invented).
  const type = positionals[0];
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (type === "task") {
    const from = flag("--from");
    if (!from) {
      process.stdout.write(
        JSON.stringify({
          error: "Usage",
          message: "new task needs --from <SPEC-id>",
        }),
      );
      process.exit(2);
    }
    const scopeFlag = flag("--scope");
    const scope =
      typeof scopeFlag === "string" && scopeFlag.length > 0
        ? scopeFlag.split(",")
        : [];
    const slug = from.replace(/^SPEC-/i, "").toLowerCase();
    const path = inStore(
      `task-${slug}.md`,
      `---\ntype: task\nid: TASK-${slug}\nsource: ${from}\n---\n`,
    );
    emit({
      level: "clean",
      path,
      taskId: `TASK-${slug}`,
      specId: from,
      scope,
      autoSuffixed: false,
    });
  } else {
    process.stdout.write(
      JSON.stringify({ error: "Usage", message: `unknown new type: ${type}` }),
    );
    process.exit(2);
  }
} else {
  process.stdout.write(
    JSON.stringify({ error: "Usage", message: `unknown verb: ${verb}` }),
  );
  process.exit(2);
}
