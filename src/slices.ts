// The concise projections for the read tools (AC-013). Each `slice_*` maps the CLI's VERBATIM `--json`
// payload to a smaller, targeted view returned in concise `response_format` — the relevant slice an agent
// acts on, ≈⅓ the tokens of the detailed (verbatim) payload. The rule: keep the IDENTIFIERS and the
// triage-bearing fields, drop the prose bodies, line numbers, evidence text, and rarely-branched
// frontmatter. Each slice is total + defensive: it reads only fields it knows and falls back to the
// verbatim data if the shape is unrecognised, so concise never throws on a drifted payload (the contract
// tripwire owns drift-detection; slicing must not become a second failure mode).
//
// These are PURE shape reducers — they add no field of their own and no verdict; they only omit.

type Obj = Record<string, unknown>;

function as_obj(value: unknown): Obj | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

function as_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// corpus status → the board: spec ids/status + a task summary, plus the two headline triage lists.
// Drops nothing structural; collapses each task to {id, reviewStatus} (the fields an agent acts on).
export function slice_status(data: unknown): unknown {
  const board = as_obj(data);
  if (board === null) {
    return data;
  }
  return {
    level: board.level,
    specs: as_array(board.specs).map((s) => {
      const spec = as_obj(s) ?? {};
      return {
        id: spec.id,
        status: spec.status,
        tasks: as_array(spec.tasks).map((t) => {
          const task = as_obj(t) ?? {};
          return { id: task.id, reviewStatus: task.reviewStatus };
        }),
      };
    }),
    tasksWithoutReview: board.tasksWithoutReview,
    needsHuman: board.needsHuman,
  };
}

// corpus check <file> → keep the outcome + the diagnostics' actionable triple (code/severity/message);
// drop the path echo and line numbers (the detailed payload carries them).
export function slice_file_check(data: unknown): unknown {
  const check = as_obj(data);
  if (check === null) {
    return data;
  }
  return {
    level: check.level,
    diagnostics: as_array(check.diagnostics).map((d) => {
      const diag = as_obj(d) ?? {};
      return {
        code: diag.code,
        severity: diag.severity,
        message: diag.message,
      };
    }),
  };
}

// corpus check (workspace) → the verdict + ONLY the artifacts that carry a diagnostic or a finding (the
// clean ones are noise in concise mode). Each problem artifact keeps its path + diagnostic triples.
export function slice_workspace_check(data: unknown): unknown {
  const check = as_obj(data);
  if (check === null) {
    return data;
  }
  const problems = (key: string): unknown[] =>
    as_array(check[key])
      .filter((s) => as_array(as_obj(s)?.diagnostics).length > 0)
      .map((s) => {
        const spec = as_obj(s) ?? {};
        return {
          path: spec.path,
          level: spec.level,
          diagnostics: as_array(spec.diagnostics).map((d) => {
            const diag = as_obj(d) ?? {};
            return {
              code: diag.code,
              severity: diag.severity,
              message: diag.message,
            };
          }),
        };
      });
  return {
    level: check.level,
    verdict: check.verdict,
    specs: problems("specs"),
    changePlans: problems("changePlans"),
    workspaceFindings: check.workspaceFindings,
  };
}

// corpus show task → the scope-bearing identity slice; drops doNotChange / claimedChangedFiles and the
// embedded requirements' verify commands (the detailed payload carries them).
export function slice_show_task(data: unknown): unknown {
  const env = as_obj(data);
  const value = as_obj(env?.value);
  if (env === null || value === null) {
    return data;
  }
  return {
    kind: env.kind,
    value: {
      id: value.id,
      source: value.source,
      status: value.status,
      scope: value.scope,
      affectedAreas: value.affectedAreas,
      embeddedSpecId: value.embeddedSpecId,
    },
  };
}

// corpus show spec → the id/status + requirement IDS + section titles; drops the big append-only
// `## Execution` prose body, the per-requirement line numbers + verify commands, and the verbose
// living-spec frontmatter (kept whole in detailed mode).
export function slice_show_spec(data: unknown): unknown {
  const env = as_obj(data);
  const value = as_obj(env?.value);
  const frontmatter = as_obj(value?.frontmatter);
  if (env === null || value === null) {
    return data;
  }
  return {
    kind: env.kind,
    value: {
      id: frontmatter?.id,
      status: frontmatter?.status,
      requirements: as_array(value.requirements).map(
        (r) => as_obj(r)?.id,
      ),
      sectionTitles: value.sectionTitles,
      openQuestionsPresent: value.openQuestionsPresent,
      hasExecution: typeof value.execution === "string",
    },
  };
}

// corpus show review → status + each coverage row's {id, result} (drops the evidence prose), the verify
// blocks' pass/fail summary, and the identity (which spec/task it reviews); drops the staleness pins.
export function slice_show_review(data: unknown): unknown {
  const env = as_obj(data);
  const value = as_obj(env?.value);
  const frontmatter = as_obj(value?.frontmatter);
  if (env === null || value === null) {
    return data;
  }
  return {
    kind: env.kind,
    value: {
      status: value.status,
      coverageRows: as_array(value.coverageRows).map((r) => {
        const row = as_obj(r) ?? {};
        return { id: row.id, result: row.result };
      }),
      verifyBlocks: as_array(value.verifyBlocks).map((b) => {
        const block = as_obj(b) ?? {};
        return { id: block.id, result: block.result };
      }),
      reviews: { spec: frontmatter?.spec, task: frontmatter?.task },
    },
  };
}

// Project the board (corpus status) into a FLAT enumeration of specs or tasks (AC-012). There is no
// `corpus list` verb; the board is the enumeration source, so corpus_list projects it. Defensive: reads
// only known fields, falls back to the verbatim board if the shape is unrecognised (the contract tripwire
// owns drift). Adds no field of its own and no verdict.
export function list_from_board(
  data: unknown,
  kind: "specs" | "tasks",
): unknown {
  const board = as_obj(data);
  if (board === null) {
    return data;
  }
  const specs = as_array(board.specs);
  if (kind === "specs") {
    return {
      kind: "specs",
      specs: specs.map((s) => {
        const spec = as_obj(s) ?? {};
        return { id: spec.id, status: spec.status };
      }),
    };
  }
  const tasks: unknown[] = [];
  for (const s of specs) {
    const spec = as_obj(s) ?? {};
    for (const t of as_array(spec.tasks)) {
      const task = as_obj(t) ?? {};
      tasks.push({
        id: task.id,
        spec: spec.id,
        status: task.status,
        hasReview: task.hasReview,
        reviewStatus: task.reviewStatus,
      });
    }
  }
  return { kind: "tasks", tasks };
}

// corpus show checks → version + each check's {id, severity}; drops the human-readable `name`.
export function slice_show_checks(data: unknown): unknown {
  const env = as_obj(data);
  const value = as_obj(env?.value);
  if (env === null || value === null) {
    return data;
  }
  return {
    kind: env.kind,
    value: {
      version: value.version,
      checks: as_array(value.checks).map((c) => {
        const check = as_obj(c) ?? {};
        return { id: check.id, severity: check.severity };
      }),
    },
  };
}
