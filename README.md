# suspec-mcp

An MCP stdio adapter for shell-less access to Suspec's deterministic checker. It requires checks
contract `0.19.0`, validates every CLI JSON payload, and preserves ordered reports and exit status.

## Tools

### `suspec_check`

Runs one CLI process over an ordered non-empty array of absolute artifact paths. Frontmatter `type:`
selects behavior.

| Input            | Meaning                                         |
| ---------------- | ----------------------------------------------- |
| `paths`          | ordered non-empty absolute primary paths        |
| `specPath`       | absolute spec companion for one review          |
| `taskPath`       | optional absolute task companion for one review |
| `responseFormat` | `concise` or `detailed`                         |

Spec, task, change-plan, and review inputs receive their CLI checks. Inventory, audit, and research
return `checked: false`. Missing and unknown types are rejected.

One invocation preserves cross-file checks such as C002. Companions are valid only when `paths`
contains exactly one review target. Missing, unreferenced, or ambiguous companions produce the CLI's
structured refusal with `ok: false`.

Every artifact result repeats its type. Only the optional final `(file set)` report has none.

### `suspec_get_checks`

Returns the contract version and each core check's ID, name, and severity. The same contract is
available at `suspec://checks`.

Startup and resource reads require exact contract `0.19.0` at exit 0. Resource failure throws instead
of returning an error document as resource content.

## Envelope

Every successful adapter invocation returns:

- `ok`: whether the CLI ran and produced a valid payload, not whether diagnostics are clean;
- `source`: exact command and exit code;
- `data`: validated detailed output or concise projection;
- optional `note`;
- `responseFormat`.

A check with blocking diagnostics remains `ok: true`; inspect `data.level`, diagnostics, and
`source.exitCode`.

CLI exits `0`, `1`, and `2` belong to the contract. Any other exit is an adapter launch failure,
even when stdout resembles JSON. Structured CLI errors are accepted only at exit `2`.

## Install

Requires Node.js 22.6 or newer and a
[suspec CLI](https://github.com/jcosta33/suspec-cli). Neither package is published.

```sh
git clone https://github.com/jcosta33/suspec-mcp
cd suspec-mcp
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Configure absolute entry points so GUI clients do not depend on shell `PATH`:

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

CLI precedence:

| Flag                  | Environment  | Default            |
| --------------------- | ------------ | ------------------ |
| `--suspec-bin <path>` | `SUSPEC_BIN` | `suspec` on `PATH` |

Each tool call supplies full artifact paths. The server binds no repository, workspace,
configuration, or store. `~/.agents/artifacts/<workspace>/` has no special runtime meaning.

## Security

- Primary and companion paths must be absolute and contain no control, format, or line-separator
  characters.
- The adapter passes a fixed argument array without a shell.
- Only `check` and supported companion or contract flags reach the CLI.
- The CLI check surface is read-only.

The server can read any path available to its process. Match its filesystem permissions to the client
trust boundary or apply OS sandboxing.

## Develop

Fixture drift uses the real CLI. Set `SUSPEC_BIN` to an absolute CLI source path; otherwise a sibling
package named `suspec-cli` may satisfy discovery. Generation rejects other packages.

```sh
export SUSPEC_BIN=/absolute/path/to/suspec-cli/bin/suspec.js
pnpm install
pnpm test:run
pnpm gate
pnpm fixtures
```

`test/fixtures/provenance.json` records CLI git HEAD, complete dirty-worktree hash, and binary hash.
`scripts/generate-fixtures.mjs` captures output; tests parse every fixture through
`src/suspec/contract.ts`. Fixtures are generated, never hand-edited.

## License

MIT
