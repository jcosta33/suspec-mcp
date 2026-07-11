// The concise projections for the tools. Each `slice_*` maps the CLI's VERBATIM `--json` payload to a
// smaller, targeted view returned in concise `response_format` — the relevant slice an agent acts on,
// vs the detailed (verbatim) payload. The rule: keep the IDENTIFIERS and the triage-bearing fields,
// drop the echoes (a report's path echo, a diagnostic's line anchor, a check's human-readable name).
// Each slice is total + defensive: it reads only fields it knows and falls back to the verbatim data
// if the shape is unrecognised, so concise never throws on a drifted payload (the contract tripwire
// owns drift-detection; slicing must not become a second failure mode).
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

// suspec check <artifact> → keep the outcome + the diagnostics' actionable triple
// (code/severity/message); drop the path echo and line numbers (the detailed payload carries them).
// An artifact whose type has no check face keeps its `{level, type, checked:false}` notice whole —
// dropping `checked` would misread "nothing was validated" as "validated clean".
export function slice_check_file(data: unknown): unknown {
  const check = as_obj(data);
  if (check === null) {
    return data;
  }
  // An object bearing NONE of the fields this slice reads is an unrecognised shape — return it
  // verbatim rather than fabricate an empty-clean `{diagnostics: []}` projection.
  if (
    check.level === undefined &&
    check.checked === undefined &&
    check.diagnostics === undefined
  ) {
    return data;
  }
  if (check.checked === false) {
    return { level: check.level, type: check.type, checked: false };
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

// suspec check --contract → version + each check's {id, severity}; drops the human-readable `name`.
export function slice_contract(data: unknown): unknown {
  const contract = as_obj(data);
  if (contract === null) {
    return data;
  }
  // Same unrecognised-shape guard as slice_check_file: no known field, no fabricated slice.
  if (contract.version === undefined && contract.checks === undefined) {
    return data;
  }
  return {
    version: contract.version,
    checks: as_array(contract.checks).map((c) => {
      const check = as_obj(c) ?? {};
      return { id: check.id, severity: check.severity };
    }),
  };
}
