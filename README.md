# suspec-mcp

An MCP stdio server that gives shell-less agent clients access to Suspec's deterministic artifact
checking.

It is a thin, hardened adapter over the [`suspec` CLI](https://github.com/jcosta33/suspec-cli):
every tool call shells out to `suspec check --json` and relays the CLI's recorded diagnostics,
severity levels, and exit codes under a **no-verdict envelope**. The server never adds a assessment or acceptance,
approval, or merge decision of its own; the human decides what those facts mean for the work.

## Why it exists

The Suspec CLI checks structural facts such as requirement coverage, verify-command binding,
evidence presence, and reference resolution. A terminal agent can run `suspec check` directly. This
server exposes the same command contract to a client without shell access.

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
An artifact type with no check face comes back as `checked: false`; nothing to validate is not a
defect.

This tool accepts one primary artifact, so the CLI's cross-file duplicate-ID check (C002) cannot run
through this surface. Use `suspec check <path> [<path>...]` directly when C002 across a file set is
required. Expanding the MCP input surface is a separate product decision.

| input             | meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `path`            | full path to the artifact to check                           |
| `spec`            | full path to the source spec, when checking a review         |
| `task`            | full path to the task packet, when the review names a task   |
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
  `concise` mode (the default).
- `noVerdictIssued: true` — always, on every result.

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
workspace, configuration file, or artifact store. Callers may pass ordinary Suspec artifacts from
`~/.agents/artifacts/<workspace>/`; the server treats that root like any other explicit path.

## Security posture

The server keeps the subprocess boundary narrow:

- **Full paths, passed through** — the checked artifact and companions must be absolute paths with no
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

The JSON contract between this server and the CLI is pinned by generated fixtures:
`scripts/generate-fixtures.mjs` captures the real binary's output, and the test suite parses
every fixture through the schemas in `src/suspec/contract.ts` — a renamed or dropped field
fails a test instead of the adapter silently producing wrong output. Fixtures are generated,
never hand-edited.

## License

MIT
