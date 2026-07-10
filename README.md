# suspec-mcp

An MCP stdio server that gives agent clients without a shell — Claude Desktop, Cursor, and
anything else that speaks the Model Context Protocol — access to Suspec's deterministic
artifact checking.

It is a thin, hardened adapter over the [`suspec` CLI](https://github.com/jcosta33/suspec-cli):
every tool call shells out to `suspec check --json` and relays the CLI's recorded facts —
diagnostics, severity levels, exit codes — under a **no-verdict envelope**. The server never
adds a Pass/Fail, approval, or merge decision of its own; what a finding means for the work is
the human's call.

## Why it exists

Suspec's honesty floor is a set of deterministic checks a reviewer cannot fake: coverage rows
that match the spec's requirements, verify commands that match what the spec named, Pass rows
that carry evidence, references that resolve. A terminal agent runs `suspec check` directly.
A shell-less client cannot — this server is that client's way to run the same checks against
the same files, with the same results.

## The tools

### `suspec_check_file`

Run the checks contract over ONE artifact file. The artifact's kind is read from its own
frontmatter `type:` — nothing is inferred from filenames or directory layout:

- a **spec** runs the spec checks,
- a **change-plan** runs the plan checks,
- a **review packet** reconciles against the companion files you pass explicitly:
  - `spec` — always required for a review,
  - `task` — required exactly when the review's frontmatter names a `task:`.

The CLI refuses a missing or unreferenced companion with a blocking error rather than
silently checking less; that refusal surfaces as `ok: false` with the CLI's own message.
An artifact type with no check face (a task packet, a finding) comes back as
`checked: false` — nothing to validate is not a defect.

| input | meaning |
| --- | --- |
| `path` | workspace-relative path to the artifact to check |
| `spec` | (optional) the source spec a review reconciles against |
| `task` | (optional) the task packet whose scope keys the review's coverage |
| `response_format` | `concise` (default) or `detailed` (the verbatim CLI payload) |

### `suspec_get_checks`

The checks contract the CLI holds artifacts to (`suspec check --contract`): the contract
version plus every core check's id, name, and severity. Also served as the fixed resource
`suspec://checks`.

## The envelope

Every tool result carries the same structure:

- `ok` — **runnability, not a result**: the CLI ran and returned a parseable payload. A check
  that found blocking diagnostics is still `ok: true`; read `data.level`, `data.diagnostics`,
  and `source.exitCode` for the CLI's own recorded facts.
- `source` — provenance: the exact CLI command run and its exit code
  (0 clean · 1 warnings · 2 blocking / structured error).
- `data` — the CLI's `--json` output, verbatim in `detailed` mode or a targeted slice in
  `concise` mode (the default, roughly a third of the tokens).
- `noVerdictIssued: true` — always, on every result.

## Run it

Requires Node.js ≥ 22.6 and a [`suspec` CLI](https://github.com/jcosta33/suspec-cli) binary.

```jsonc
// e.g. Claude Desktop's claude_desktop_config.json, or any MCP client config
{
  "mcpServers": {
    "suspec": {
      "command": "suspec-mcp",
      "args": [
        "--workspace", "/absolute/path/to/your/repo",
        "--suspec-bin", "/absolute/path/to/suspec-cli/bin/suspec.js"
      ]
    }
  }
}
```

Configuration precedence is flags > environment > cwd:

| flag | env | default | meaning |
| --- | --- | --- | --- |
| `--workspace <path>` | `SUSPEC_WORKSPACE` | the server's cwd | the ONE repo this server instance is bound to |
| `--suspec-bin <path>` | `SUSPEC_BIN` | `suspec` on PATH | the CLI binary to shell out to |

## Security posture

The server treats every client input as hostile:

- **Root confinement** — every path (the checked artifact AND both companions) must resolve
  inside the bound workspace root: `..` traversal, absolute escapes, flag-shaped paths, and
  symlinks pointing out of the root are all rejected before any subprocess runs.
- **Fixed argv** — the CLI is invoked with a fixed argument array, never a shell string.
- **Allow-lists** — the one verb (`check`) and the three flags (`--spec`, `--task`,
  `--contract`) are the only argv shapes that can reach the CLI; anything else throws inside
  the adapter.
- **Read-only** — the CLI's check surface writes nothing, and the test suite pins that the
  adapter never passes a mutation-shaped flag.

## Develop

```sh
pnpm install
pnpm test:run     # the suite (in-memory + real-stdio transport, against a stub CLI)
pnpm gate         # typecheck + lint + coverage (enforced thresholds) + build
pnpm fixtures     # regenerate the contract fixtures from a real suspec binary
```

The JSON contract between this server and the CLI is pinned by generated fixtures:
`scripts/generate-fixtures.mjs` captures the real binary's output, and the test suite parses
every fixture through the schemas in `src/suspec/contract.ts` — a renamed or dropped field
fails a test instead of the adapter silently producing wrong output. Fixtures are generated,
never hand-edited.

## License

MIT
