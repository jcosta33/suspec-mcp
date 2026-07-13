# suspec-mcp

An MCP stdio server that gives shell-less agent clients access to Suspec's deterministic artifact
checking.

It is a thin adapter over the [`suspec` CLI](https://github.com/jcosta33/suspec-cli). It requires
checks contract `0.19.0`, validates every CLI JSON document at runtime, and returns the CLI's ordered
reports and exit code.

## Why it exists

The Suspec CLI checks structural facts such as requirement coverage, verify-command binding,
evidence presence, and reference resolution. A terminal agent can run `suspec check` directly. This
server exposes the same command contract to a client without shell access.

## The tools

### `suspec_check`

Run one CLI process over an ordered, non-empty array of absolute artifact paths. The artifact kind
comes from frontmatter `type:`; filenames and directories carry no meaning. One invocation enables
cross-file checks such as C002.

- a **spec** runs the spec checks,
- a **task** runs the shape, evidence, and closure checks,
- a **change-plan** runs the plan checks,
- a **review packet** reconciles against explicit `specPath` and optional `taskPath` companions.

The CLI refuses a missing or unreferenced companion with a blocking error rather than
silently checking less; that refusal surfaces as `ok: false` with the CLI's own message.
Recognized unchecked types (`inventory`, `audit`, and `research`) come back as
`checked: false`; missing and unknown types are rejected by the CLI.
Each per-artifact result repeats its recognized `type`; only the optional final `(file set)` C002
report has no artifact type.

Companions are valid only when `paths` contains exactly one review target. A CLI refusal remains
structured data with `ok: false`.

| input            | meaning                                                         |
| ---------------- | --------------------------------------------------------------- |
| `paths`          | ordered, non-empty array of absolute primary artifact paths    |
| `specPath`       | absolute source-spec path for one review target                 |
| `taskPath`       | absolute task-packet path for one review target                 |
| `responseFormat` | `concise` (default) or `detailed` (validated CLI payloads)      |

### `suspec_get_checks`

The checks contract the CLI holds artifacts to (`suspec check --contract`): the contract
version plus every core check's id, name, and severity. Also served as the fixed resource
`suspec://checks`.

The startup compatibility probe and every resource read require the exact `0.19.0` contract at exit
0. A failed resource invocation throws instead of serving an error document as resource content.

## The envelope

Every tool result carries the same structure:

- `ok` — **runnability, not a result**: the CLI ran and returned a parseable payload. A check
  that found blocking diagnostics is still `ok: true`; read `data.level`, `data.diagnostics`,
  and `source.exitCode` for the CLI's own recorded facts.
- `source` — provenance: the exact CLI command run and its exit code
  (0 clean · 1 warnings · 2 blocking / structured error).
- `data` — the CLI's `--json` output, verbatim in `detailed` mode or a targeted slice in
  `concise` mode (the default). `suspec_check` always returns an ordered array; an optional final
  `(file set)` report carries cross-file findings.
- `note` — optional adapter context when needed.
- `responseFormat` — `concise` or `detailed`.

Only child exits 0, 1, and 2 belong to the CLI contract. Any other exit is an adapter launch failure,
even when stdout resembles valid JSON; a structured CLI error document is accepted only at exit 2.

## Run it

Requires Node.js ≥ 22.6 and a [`suspec` CLI](https://github.com/jcosta33/suspec-cli) binary. Neither
package is published; install both from source. After installing the CLI:

```sh
git clone https://github.com/jcosta33/suspec-mcp
cd suspec-mcp
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Pass both source entry points by absolute path so a GUI client does not depend on the shell's
`PATH`.

```json
{
  "mcpServers": {
    "suspec": {
      "command": "/absolute/path/to/suspec-mcp/bin/suspec-mcp.js",
      "args": ["--suspec-bin", "/absolute/path/to/suspec-cli/bin/suspec.js"]
    }
  }
}
```

This is strict JSON suitable for Claude Desktop's `claude_desktop_config.json` and other MCP clients.

CLI-binary configuration precedence is flag > environment > `suspec` on PATH:

| flag                  | env          | default          | meaning                  |
| --------------------- | ------------ | ---------------- | ------------------------ |
| `--suspec-bin <path>` | `SUSPEC_BIN` | `suspec` on PATH | the CLI binary to invoke |

Each tool call supplies full artifact paths. The server does not discover or bind a repository root,
workspace, configuration file, or artifact store. Callers may pass the resolved absolute path of
ordinary Suspec artifacts under `~/.agents/artifacts/<workspace>/`; the server treats that root like
any other explicit path.

## Security posture

The server keeps the subprocess boundary narrow:

- **Full paths, passed through** — primary artifacts and companions must be absolute paths with no
  control, format, or line-separator characters. They are passed to the CLI unchanged; the server
  resolves no root or tree.
- **Fixed argv** — the CLI is invoked with a fixed argument array, never a shell string.
- **Allow-lists** — only the `check` verb and its supported companion/contract flags can reach the
  CLI; anything else throws inside the adapter.
- **Read-only** — the CLI's check surface writes nothing, and the test suite pins that the
  adapter never passes a mutation-shaped flag.

The MCP client can ask the server to read any path available to the server process. Run it with the
same filesystem permissions and client trust boundary you intend to grant; use OS-level sandboxing
when a narrower read boundary is required.

## Develop

The fixture drift test runs the real CLI and fails when it cannot find one. Set `SUSPEC_BIN` to an
absolute CLI source path; a sibling checkout whose package name is `suspec-cli` is also detected.
Fixture generation rejects another package and records the CLI git HEAD, complete dirty-worktree
hash, and binary hash in `test/fixtures/provenance.json` before comparing outputs.

```sh
export SUSPEC_BIN=/absolute/path/to/suspec-cli/bin/suspec.js
pnpm install
pnpm test:run     # adapter tests use a stub; fixture drift uses the real CLI
pnpm gate         # typecheck + lint + coverage (enforced thresholds) + build
pnpm fixtures     # regenerate the contract fixtures from a real suspec binary
```

The JSON contract between this server and the CLI is enforced at startup and on every invocation,
then pinned by generated fixtures:
`scripts/generate-fixtures.mjs` captures the real binary's output, and the test suite parses
every fixture through the schemas in `src/suspec/contract.ts` — a renamed or dropped field
fails a test instead of the adapter silently producing wrong output. Fixtures are generated,
never hand-edited.

## License

MIT
