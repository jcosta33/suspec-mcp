# corpus-mcp

An [MCP](https://modelcontextprotocol.io) stdio server that puts [Corpus](https://github.com/jcosta33/corpus)'s
spec/review discipline inside an agent's reach — so an agent mid-task can ask Corpus _"what's my scope?"_,
_"what evidence is missing?"_, _"what should the reviewer not miss?"_ — and **be told facts and a
human-attention list, never a Pass/Fail it could launder into a green checkmark.**

## Why it exists (the non-bypassable value)

Two things here are not available by handing an agent a shell:

1. **The no-verdict envelope is a guarantee, not a convenience.** Every reconcile/read result carries
   `noVerdictIssued: true` and a _derived, structured_ human-attention list — coverage gaps, out-of-scope
   changes, empty-evidence Pass rows, self-report mismatches, each as `{category, severity, message, ref}`.
   corpus-mcp surfaces _facts_; a human or an independent reviewer owns the Pass / Fail / Unverified /
   Blocked result. An empty or weak Evidence cell reads Unverified regardless of a clean reconcile. An
   agent _cannot_ make this server declare its own work done — that is the product's point (ADR-0077 D8,
   ADR-0063).
2. **It serves clients that have no shell.** Claude Desktop, Cursor, and other non-terminal clients cannot
   run `corpus … --json` themselves. For them the MCP _resources_ (the board, the checks contract, parsed
   specs/tasks/reviews/findings) and _prompts_ (the implementer/reviewer stances) are the only way to bring
   Corpus's context into the conversation — application-driven context + procedural nudges, not a CLI wrap.

For a terminal agent the _tools_ tier is largely a typed, sliced convenience over the same `--json`; the
durable value above is what a raw shell does not give you.

## What it does — and what it never does

It spawns `corpus <cmd> --json` with a FIXED argv (never a shell string, never a client-injected flag) and
reshapes the output into MCP tools, resources, and prompts. It does **not** import corpus-cli's internals,
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
  CLI enum value is not a corpus-mcp break. The fixtures are **generated** from the real binary
  (`pnpm fixtures`), and a test re-runs the generator so they can't go stale.
- **Many libraries, not a framework.** It couples to corpus-cli only through the public `--json` interface
  (corpus [ADR-0085](https://github.com/jcosta33/corpus/blob/main/docs/adrs/0085-corpus-mcp-adapts-the-json-contract.md)),
  so corpus-cli keeps its minimal footprint and each piece stays useful on its own.

## Run it

```jsonc
// Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "corpus": {
      "command": "corpus-mcp",
      "args": ["--workspace", "/path/to/your/corpus-workspace"],
    },
  },
}
```

Config: `--workspace <path>` / `CORPUS_WORKSPACE` (the workspace root); `--corpus-bin <path>` / `CORPUS_BIN`
(the `corpus` binary, default `corpus` on PATH). Requires the [`corpus` CLI](https://github.com/jcosta33/corpus-cli)
installed.

The `corpus-mcp` command above resolves to this package's bin. To install from source until a published
build is available:

```sh
git clone https://github.com/jcosta33/corpus-mcp && cd corpus-mcp
pnpm install && pnpm build && npm link   # exposes `corpus-mcp` on PATH (runs the built dist/)
```

Node: a published/built install needs Node ≥ 18.18; running from a source checkout (no `dist/`) needs
Node ≥ 22.6 (it strips types at runtime).

## Surface

- **Read tools (8).** `corpus_get_status`, `corpus_list` (enumerate specs/tasks for an agent that has no
  id), `corpus_check_workspace`, `corpus_check_file` (a spec, change-plan, or review packet — the one check
  path), `corpus_get_task`, `corpus_get_spec`, `corpus_get_review`, `corpus_get_checks`. Each declares an
  `outputSchema` and takes a `response_format: concise|detailed` — concise returns the relevant slice
  (~⅓ the tokens), the verbatim payload on demand.
- **Reconcile tool (1).** `corpus_reconcile` — reconcile a `task` (or a `spec`, for the task-less 1:1
  review-to-spec case, ADR-0103) against its spec and the worktree diff. ONE engine whether or not a review
  packet exists yet (the report carries `hasReviewPacket`; there is no separate scan tool). The
  implementer-vs-reviewer _stance_ split lives in the prompts, not in two tools.
- **Safe-write tools (3) — verdict-free prepare ops.** `corpus_scaffold_spec` (`new spec`),
  `corpus_split_task` (`new task --from`, scope copied not invented), `corpus_scaffold_finding`
  (`promote`). Each scaffolds one fresh artifact, writes no board/result, and issues no verdict.
- **Resources (7).** Fixed: `corpus://workspace`, `corpus://status`, `corpus://checks`. Templated:
  `corpus://tasks/{id}`, `corpus://specs/{id}`, `corpus://reviews/{id}`, `corpus://findings/{id}`.
- **Prompts (5).** `corpus_task_briefing`, `corpus_before_done` (the implementer — _may not approve its own
  work_), `corpus_review_assistant` (an independent reviewer — _falsify, don't trust_), `corpus_evidence_rule`,
  `corpus_finding_candidate` (backed by `corpus_scaffold_finding`). The before-done / review-assistant
  asymmetry is deliberate: no prompt grants verdict authority.

## Develop

```sh
pnpm install
pnpm gate       # typecheck + lint + coverage (thresholds enforced) + build
pnpm fixtures   # regenerate the contract fixtures from the real `corpus` binary
```
