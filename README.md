# suspec-mcp

An [MCP](https://modelcontextprotocol.io) stdio server that puts [Suspec](https://github.com/jcosta33/suspec)'s
personal-harness discipline inside an agent's reach — so an agent mid-run can ask Suspec _"what's in the
store?"_, _"what evidence is missing?"_, _"what will `done` gate on?"_ — and **be told facts and a
human-attention list, never a Pass/Fail it could launder into a green checkmark.**

Suspec v2 is a personal harness (ADR-0137): artifacts — intake, spec, run, review, finding — are the
agent's transient typed working memory in a user-level **store** (default `~/.claude/state/<repo-name>/`),
never repo files. There is no committed workspace, no board, and no workspace verdict. Durability is by
promotion (ADRs, tests, GitHub issues, PR comments) — via the CLI, not this server.

## Why it exists (the non-bypassable value)

Two things here are not available by handing an agent a shell:

1. **The no-verdict envelope is a guarantee, not a convenience.** Every reconcile/read result carries
   `noVerdictIssued: true` and a _derived, structured_ human-attention list — artifact-lint diagnostics
   and evidence gaps, each as `{category, severity, message, ref}`. suspec-mcp surfaces _facts_; the
   human owns the result — `suspec done` is the gate, and an AC without fresh, exit-0, cli-verified
   evidence reads as a gap regardless of a clean lint. An agent _cannot_ make this server declare its
   own work done — that is the product's point.
2. **It serves clients that have no shell.** Claude Desktop, Cursor, and other non-terminal clients cannot
   run `suspec … --json` themselves. For them the MCP _resources_ (the store summary, the checks contract)
   and _prompts_ (the implementer/reviewer stances) are the only way to bring Suspec's context into the
   conversation — application-driven context + procedural nudges, not a CLI wrap.

For a terminal agent the _tools_ tier is largely a typed, sliced convenience over the same `--json`; the
durable value above is what a raw shell does not give you.

## What it does — and what it never does

It spawns `suspec <cmd> --json` with a FIXED argv (never a shell string, never a client-injected flag) and
reshapes the output into MCP tools, resources, and prompts. It does **not** import suspec-cli's internals,
run a model loop, launch a runner, close a gate, promote a finding, or issue a verdict.

- **Reconcile-only, verdict-free — including the safe-write tier.** The safe-write tools
  (`scaffold_spec` / `split_task`) are verdict-free _prepare ops_: they scaffold a fresh STORE artifact
  via the CLI's `write spec` / `new task --from`, and dispatch nothing, overwrite nothing, and gate
  nothing (no `--write`/`--force`/`--agent`/`--launch` flag ever leaves the adapter).
- **Confined inputs.** File paths are realpath-confined to the bound repo root (no `..`, no absolute
  escapes, no symlink escapes); run/spec/AC ids must be a single safe segment; a spec intent is a bounded,
  flag-free one-liner; the verb _and_ flag are allow-list-checked at the one subprocess edge. The
  mutation verbs (`work`, `done`, `evidence`, `fix`, `promote`) are not on the allow-list at all.
- **A typed contract that bends only where it should.** The CLI `--json` shapes are mirrored as a drift
  tripwire (a renamed/dropped field the adapter _reads_ fails a test, not silently-wrong output), but a
  pass-through-only enum (a CLI status class the adapter merely relays) is `z.string()` — a benign additive
  CLI enum value is not a suspec-mcp break. The fixtures are **generated** from the real binary
  (`pnpm fixtures`), and a test re-runs the generator so a stale fixture fails wherever a suspec-cli
  checkout is present (found via `SUSPEC_BIN` or a sibling checkout; absent one, the suite skips with a
  loud warning rather than silently disarming).
- **Many libraries, not a framework.** It couples to suspec-cli only through the public `--json` interface,
  so suspec-cli keeps its minimal footprint and each piece stays useful on its own.

## Run it

The server is one command — `suspec-mcp --workspace <repo-root>` — wired into each client's MCP config.
`--workspace` names the REPO the server is bound to (the store for that repo is resolved by the CLI:
`SUSPEC_STATE_DIR` > `state_root` in `suspec.config.json` > `~/.claude/state`). The JSON shape below is
shared by **Claude Desktop, Claude Code, and Cursor** (Claude Code stores it in `~/.claude.json` under
`mcpServers`, or `.mcp.json` in a project); **Codex** uses TOML; **opencode** uses its own JSON block.

```jsonc
// Claude Desktop / Claude Code / Cursor
{
  "mcpServers": {
    "suspec": {
      "command": "suspec-mcp",
      "args": ["--workspace", "/path/to/your/repo"],
    },
  },
}
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.suspec]
command = "suspec-mcp"
args = ["--workspace", "/path/to/your/repo"]
```

```jsonc
// opencode — opencode.jsonc
{
  "mcp": {
    "suspec": {
      "type": "local",
      "command": ["suspec-mcp", "--workspace", "/path/to/your/repo"],
    },
  },
}
```

Config: `--workspace <path>` / `SUSPEC_WORKSPACE` (the repo root); `--suspec-bin <path>` / `SUSPEC_BIN`
(the `suspec` binary, default `suspec` on PATH). Requires the [`suspec` CLI](https://github.com/jcosta33/suspec-cli)
installed. **One repo per instance:** a server binds to exactly one root at launch and cannot switch or
serve several; working across repos means one configured server entry per repo (or a restart with a
different path). The `suspec_get_status` tool names the root it serves so an agent can tell which repo it
is talking to. The server binary is named `suspec-mcp` — an older `corpus-mcp` name predates the rename and
resolves to nothing; a config still pointing at it silently starts no server.

The `suspec-mcp` command above resolves to this package's bin. To install from source until a published
build is available:

```sh
git clone https://github.com/jcosta33/suspec-mcp && cd suspec-mcp
pnpm install && npm link   # exposes `suspec-mcp` on PATH (runs the TypeScript source via type-stripping)
```

Node: on Node ≥ 22.6 the launcher runs from source whenever `src/index.ts` is present (a source
checkout — even after `pnpm build`), stripping types at runtime. On older Node it falls back to the
bundled `dist/` when one exists (run `pnpm build` once), and errors only when neither path can work. A
published/files-pruned install with no `src/` always runs `dist/`, which needs Node ≥ 18.18.

## Surface

- **Read tools (5).** Each declares an `outputSchema` and takes a `response_format: concise|detailed` —
  concise returns the relevant slice, the verbatim payload on demand.
  - `suspec_get_status` — the store summary (active/archived artifacts + the `next` attention ranking).
  - `suspec_list` — enumerate the store's artifacts (`suspec store list`) for an agent without a slug.
  - `suspec_check_store` — the checks contract as artifact lint over the repo's STORE (`suspec check`).
  - `suspec_check_file` — the one check path for one repo file (a spec, change-plan, or review packet).
  - `suspec_get_checks` — the checks contract (version + the core checks).
- **Reconcile tool (1).** `suspec_reconcile` — reconcile a store `run` against its driving spec
  (`suspec review <RUN>`): artifact lint + the evidence-vs-AC rows (verified / stale / failing /
  missing), the SAME rows `suspec done` gates on, previewed without closing anything. The
  implementer-vs-reviewer _stance_ split lives in the prompts, not in two tools.
- **Safe-write tools (2) — verdict-free prepare ops.** `suspec_scaffold_spec` (`write spec "<intent>"` —
  a draft store spec; never `--launch`), `suspec_split_task` (`new task --from`, scope copied not
  invented — a store task slice). Each scaffolds one fresh store artifact and issues no verdict.
- **Resources (3).** `suspec://workspace` (the repo binding + store summary), `suspec://status`,
  `suspec://checks`.
- **Prompts (3).** `suspec_before_done` (the implementer — _may not close the gate_),
  `suspec_review_assistant` (an independent reviewer — _falsify, don't trust_), `suspec_evidence_rule`
  (only fresh cli-verified capture counts). The before-done / review-assistant asymmetry is deliberate:
  no prompt grants verdict authority.

### Retired with the v2 pivot (v0.3.0)

| v1 tool | Fate | Why |
| --- | --- | --- |
| `suspec_check_workspace` | → `suspec_check_store` | The workspace tree + workspace verdict are gone (ADR-0137); `suspec check` with no args is now the store lint. |
| `suspec_reconcile` (task/spec + `base`) | reshaped | `suspec review` now takes a store RUN slug; the diff-vs-task reconcile retired with task packets as repo files. |
| `suspec_get_task` / `suspec_get_spec` / `suspec_get_review` | retired | The CLI's `show task|spec|review` loaders resolve the workspace tree only and cannot reach the store; agents read store artifacts directly by absolute path (ADR-0137 D2). |
| `suspec_scaffold_spec` (slug) | reshaped | Specs scaffold from a one-line INTENT via `suspec write spec` — the one store scaffold. |
| `suspec_scaffold_finding` | retired | `suspec promote` now opens a GitHub issue and archives the finding — a network mutation, not a scaffold. Findings enter via runs; promotion stays in the CLI with the human. |
| templated resources (`suspec://tasks/{id}` etc.) | retired | Same store-reachability reason as the `get_*` loaders. |

## Develop

```sh
pnpm install
pnpm gate       # typecheck + lint + coverage (thresholds enforced) + build
pnpm fixtures   # regenerate the contract fixtures from the real `suspec` binary
```
