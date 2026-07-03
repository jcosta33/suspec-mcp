# suspec-mcp

An [MCP](https://modelcontextprotocol.io) stdio server that puts [Suspec](https://github.com/jcosta33/suspec)'s
spec/review discipline inside an agent's reach — so an agent mid-task can ask Suspec _"what's my scope?"_,
_"what evidence is missing?"_, _"what should the reviewer not miss?"_ — and **be told facts and a
human-attention list, never a Pass/Fail it could launder into a green checkmark.**

## Why it exists (the non-bypassable value)

Two things here are not available by handing an agent a shell:

1. **The no-verdict envelope is a guarantee, not a convenience.** Every reconcile/read result carries
   `noVerdictIssued: true` and a _derived, structured_ human-attention list — coverage gaps, out-of-scope
   changes, empty-evidence Pass rows, self-report mismatches, each as `{category, severity, message, ref}`.
   suspec-mcp surfaces _facts_; a human or an independent reviewer owns the Pass / Fail / Unverified /
   Blocked result. An empty or weak Evidence cell reads Unverified regardless of a clean reconcile. An
   agent _cannot_ make this server declare its own work done — that is the product's point.
2. **It serves clients that have no shell.** Claude Desktop, Cursor, and other non-terminal clients cannot
   run `suspec … --json` themselves. For them the MCP _resources_ (the board, the checks contract, parsed
   specs/tasks/reviews/findings) and _prompts_ (the implementer/reviewer stances) are the only way to bring
   Suspec's context into the conversation — application-driven context + procedural nudges, not a CLI wrap.

For a terminal agent the _tools_ tier is largely a typed, sliced convenience over the same `--json`; the
durable value above is what a raw shell does not give you.

## What it does — and what it never does

It spawns `suspec <cmd> --json` with a FIXED argv (never a shell string, never a client-injected flag) and
reshapes the output into MCP tools, resources, and prompts. It does **not** import suspec-cli's internals,
run a model loop, write a board, write a review result, or issue a verdict.

- **Reconcile-only, verdict-free — including the safe-write tier.** The safe-write tools
  (`scaffold_spec` / `split_task` / `scaffold_finding`) are verdict-free _prepare ops_: they scaffold a
  fresh artifact via the CLI's `new spec` / `new task --from` / `promote`, and write no board, no review
  result, and overwrite nothing (no `--write`/`--force`/`--agent` flag ever leaves the adapter).
- **Root-confined.** It only reads/scaffolds inside a configured workspace root; every client-supplied
  input is validated before any subprocess runs. File paths are realpath-confined (no `..`, no absolute
  escapes, no symlink escapes); ids/slugs/stems must be a single safe segment; a git base must be a
  flag-free ref; the verb _and_ flag are allow-list-checked at the one subprocess edge.
- **A typed contract that bends only where it should.** The CLI `--json` shapes are mirrored as a drift
  tripwire (a renamed/dropped field the adapter _reads_ fails a test, not silently-wrong output), but a
  pass-through-only enum (a CLI advisory code the adapter merely relays) is `z.string()` — a benign additive
  CLI enum value is not a suspec-mcp break. The fixtures are **generated** from the real binary
  (`pnpm fixtures`), and a test re-runs the generator so a stale fixture fails wherever a suspec-cli
  checkout is present (found via `SUSPEC_BIN` or a sibling checkout; absent one, the suite skips with a
  loud warning rather than silently disarming).
- **Many libraries, not a framework.** It couples to suspec-cli only through the public `--json` interface,
  so suspec-cli keeps its minimal footprint and each piece stays useful on its own.

## Run it

The server is one command — `suspec-mcp --workspace <path>` — wired into each client's MCP config. The
JSON shape below is shared by **Claude Desktop, Claude Code, and Cursor** (Claude Code stores it in
`~/.claude.json` under `mcpServers`, or `.mcp.json` in a project); **Codex** uses TOML; **opencode** uses
its own JSON block.

```jsonc
// Claude Desktop / Claude Code / Cursor
{
  "mcpServers": {
    "suspec": {
      "command": "suspec-mcp",
      "args": ["--workspace", "/path/to/your/suspec-workspace"],
    },
  },
}
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.suspec]
command = "suspec-mcp"
args = ["--workspace", "/path/to/your/suspec-workspace"]
```

```jsonc
// opencode — opencode.jsonc
{
  "mcp": {
    "suspec": {
      "type": "local",
      "command": ["suspec-mcp", "--workspace", "/path/to/your/suspec-workspace"],
    },
  },
}
```

Config: `--workspace <path>` / `SUSPEC_WORKSPACE` (the workspace root); `--suspec-bin <path>` / `SUSPEC_BIN`
(the `suspec` binary, default `suspec` on PATH). Requires the [`suspec` CLI](https://github.com/jcosta33/suspec-cli)
installed. **One workspace per instance:** a server binds to exactly one `--workspace` at launch and
cannot switch or serve several roots; working across workspaces means one configured server entry per
workspace (or a restart with a different path). The board tool names the root it serves so an agent can
tell which workspace it is talking to. The server binary is named `suspec-mcp` — an older `corpus-mcp` name predates the rename and
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

- **Read tools (8).** Each declares an `outputSchema` and takes a `response_format: concise|detailed` —
  concise returns the relevant slice (~⅓ the tokens), the verbatim payload on demand.
  - `suspec_get_status` — the derived workspace board (specs, tasks, review status, triage lists).
  - `suspec_list` — enumerate specs/tasks for an agent that has no id.
  - `suspec_check_workspace` — the checks contract over every spec + change plan.
  - `suspec_check_file` — the one check path for one file (a spec, change-plan, or review packet).
  - `suspec_get_task` — a parsed task packet (scope, areas, claimed changes, embedded spec slice).
  - `suspec_get_spec` — a parsed spec (frontmatter, requirements, `## Execution` run-record).
  - `suspec_get_review` — a parsed review packet (status, coverage rows, verify blocks, identity).
  - `suspec_get_checks` — the checks contract (version + the core checks).
- **Reconcile tool (1).** `suspec_reconcile` — reconcile a `task` (or a `spec`, for the task-less 1:1
  review-to-spec case) against its spec and the worktree diff. ONE engine whether or not a review
  packet exists yet (the report carries `hasReviewPacket`; there is no separate scan tool). The
  implementer-vs-reviewer _stance_ split lives in the prompts, not in two tools.
- **Safe-write tools (3) — verdict-free prepare ops.** `suspec_scaffold_spec` (`new spec`),
  `suspec_split_task` (`new task --from`, scope copied not invented), `suspec_scaffold_finding`
  (`promote`). Each scaffolds one fresh artifact, writes no board/result, and issues no verdict.
- **Resources (7).** Fixed: `suspec://workspace`, `suspec://status`, `suspec://checks`. Templated:
  `suspec://tasks/{id}`, `suspec://specs/{id}`, `suspec://reviews/{id}`, `suspec://findings/{id}`.
- **Prompts (5).** `suspec_task_briefing`, `suspec_before_done` (the implementer — _may not approve its own
  work_), `suspec_review_assistant` (an independent reviewer — _falsify, don't trust_), `suspec_evidence_rule`,
  `suspec_finding_candidate` (backed by `suspec_scaffold_finding`). The before-done / review-assistant
  asymmetry is deliberate: no prompt grants verdict authority.

## Develop

```sh
pnpm install
pnpm gate       # typecheck + lint + coverage (thresholds enforced) + build
pnpm fixtures   # regenerate the contract fixtures from the real `suspec` binary
```
