// The concise projections for the read tools (AC-013). Each `slice_*` maps the CLI's VERBATIM `--json`
// payload to a smaller, targeted view returned in concise `response_format` — the relevant slice an agent
// acts on, vs the detailed (verbatim) payload. The rule: keep the IDENTIFIERS and the
// triage-bearing fields, drop the archive noise, per-entry ages, and clean-artifact echoes. Each slice
// is total + defensive: it reads only fields it knows and falls back to the verbatim data if the shape
// is unrecognised, so concise never throws on a drifted payload (the contract tripwire owns
// drift-detection; slicing must not become a second failure mode).
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

// suspec status → the store summary: keep the active artifacts + the full `next` attention ranking
// (what an agent acts on); drop the archived listing (history, not triage — detailed carries it).
export function slice_status(data: unknown): unknown {
  const summary = as_obj(data);
  if (summary === null) {
    return data;
  }
  return {
    level: summary.level,
    active: as_array(summary.active).map((a) => {
      const artifact = as_obj(a) ?? {};
      return {
        filename: artifact.filename,
        kind: artifact.kind,
        ageDays: artifact.ageDays,
      };
    }),
    next: summary.next,
  };
}

// suspec store list → keep the store path + each artifact's {filename, kind}; drop the per-entry ages
// and the redundant counts (detailed carries them).
export function slice_store_list(data: unknown): unknown {
  const listing = as_obj(data);
  if (listing === null) {
    return data;
  }
  const entries = (key: string): unknown[] =>
    as_array(listing[key]).map((a) => {
      const artifact = as_obj(a) ?? {};
      return { filename: artifact.filename, kind: artifact.kind };
    });
  return {
    level: listing.level,
    store: listing.store,
    active: entries("active"),
    archived: entries("archived"),
  };
}

// suspec check (no args, the store lint) → the counts + ONLY the artifacts that carry a diagnostic
// (the clean ones are noise in concise mode). Each problem artifact keeps its path + diagnostics.
export function slice_store_lint(data: unknown): unknown {
  const lint = as_obj(data);
  if (lint === null) {
    return data;
  }
  return {
    level: lint.level,
    runCount: lint.runCount,
    specCount: lint.specCount,
    artifacts: as_array(lint.artifacts)
      .filter((a) => as_array(as_obj(a)?.diagnostics).length > 0)
      .map((a) => {
        const artifact = as_obj(a) ?? {};
        return {
          path: artifact.path,
          diagnostics: as_array(artifact.diagnostics).map((d) => {
            const diag = as_obj(d) ?? {};
            return {
              check: diag.check,
              severity: diag.severity,
              message: diag.message,
            };
          }),
        };
      }),
  };
}

// suspec check <file> → keep the outcome + the diagnostics' actionable triple (code/severity/message);
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

// suspec show checks → version + each check's {id, severity}; drops the human-readable `name`.
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
