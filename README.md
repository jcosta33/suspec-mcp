# corpus-mcp

An [MCP](https://modelcontextprotocol.io) stdio server that exposes [Corpus](https://github.com/jcosta33/corpus)'s
read + reconcile facts to agent clients (Claude Desktop, Cursor) — so an agent mid-task can ask Corpus
_"what's my scope?"_, _"what evidence is missing?"_, _"what should the reviewer not miss?"_ — **without
being allowed to declare itself done.**

## What it is — and what it is not

corpus-mcp is a **thin adapter over the `corpus` CLI's `--json` contract**. It spawns `corpus <cmd> --json`
with fixed arguments and reshapes the output into MCP tools, resources, and prompts. It does **not**
import corpus-cli's internals, run a model loop, write durable artifacts, or issue a verdict.

- **Reconcile-only.** Every _tool_ result carries `noVerdictIssued: true`; resources serve the CLI's
  `--json` data verbatim (also no verdict, just unwrapped). corpus-mcp surfaces _facts_ (coverage gaps,
  out-of-scope changes, empty-evidence Pass rows, self-report mismatches) and a _derived_ human-attention
  list; a human or an independent reviewer owns the Pass / Fail / Unverified / Blocked result. An empty or
  weak Evidence cell reads Unverified regardless of a clean reconcile.
- **Root-confined.** It only reads inside a configured workspace root; every client-supplied input is
  validated before any subprocess runs. File paths are realpath-confined (no `..`, no absolute escapes, no
  symlink escapes); ids/stems must be a single safe segment; a git base must be a flag-free ref.
- **Many libraries, not a framework.** It couples to corpus-cli only through the public `--json`
  interface, so corpus-cli keeps its minimal footprint and each piece stays useful on its own.

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

## v0 surface (read-only)

- **Tools (10).** Reconcile/check: `corpus_get_status`, `corpus_check_workspace`, `corpus_check_file`,
  `corpus_scan_task`, `corpus_reconcile_review`, `corpus_validate_review_packet`. Parsed-artifact loaders:
  `corpus_get_task`, `corpus_get_spec`, `corpus_get_review`, `corpus_get_checks`.
- **Resources (7).** Fixed: `corpus://workspace`, `corpus://status`, `corpus://checks`. Templated:
  `corpus://tasks/{id}`, `corpus://specs/{id}`, `corpus://reviews/{id}`, `corpus://findings/{id}`.
- **Prompts (5).** `corpus_task_briefing`, `corpus_before_done` (the implementer — _may not approve its own
  work_), `corpus_review_assistant` (an independent reviewer — _falsify, don't trust_), `corpus_evidence_rule`,
  `corpus_finding_candidate`. The before-done / review-assistant asymmetry is deliberate: no prompt grants
  verdict authority.

## Develop

```sh
pnpm install
pnpm gate   # typecheck + lint + coverage (thresholds enforced) + build
```

Status: **v0** — the full read + reconcile surface over the `corpus` CLI's `--json` contract. It couples to
corpus-cli only through that public contract (recorded in
[corpus ADR-0085](https://github.com/jcosta33/corpus/blob/main/docs/adrs/0085-corpus-mcp-adapts-the-json-contract.md)),
so corpus-cli keeps its minimal footprint and each piece stays useful on its own.
