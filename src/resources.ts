// The application-driven context surface, v2 (ADR-0137). Fixed URIs only: the repo binding + store
// summary, and the checks contract. The v1 templated artifact resources (tasks/specs/reviews/findings)
// are retired with the store pivot — the CLI's `show` loaders are workspace-tree-bound and cannot
// reach the store; agents read store artifacts directly by absolute path (ADR-0137 D2), and the store
// summary here carries every artifact's filename. All read-only.

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import { invoke_suspec, type SuspecResult } from "./suspec/invoke.ts";
import type { Ctx } from "./tools.ts";

const JSON_MIME = "application/json";

// Render a SuspecResult's payload as the resource body (the CLI data, or the structured error).
function body_of(result: SuspecResult): string {
  if (result.kind === "ok") {
    return JSON.stringify(result.data, null, 2);
  }
  if (result.kind === "structured-error") {
    return JSON.stringify(result.error, null, 2);
  }
  return JSON.stringify({ error: "adapter", message: result.message }, null, 2);
}

export function register_resources(server: McpServer, ctx: Ctx): void {
  server.registerResource(
    "workspace",
    "suspec://workspace",
    {
      title: "Suspec repo binding",
      description:
        "The repo root this server is bound to, its mode, and the current store summary.",
      mimeType: JSON_MIME,
    },
    (uri) => {
      const status = invoke_suspec(ctx.env, "status");
      const store = status.kind === "ok" ? status.data : null;
      const text = JSON.stringify(
        {
          repoRoot: ctx.root,
          // The real surface: read + reconcile tools, plus the safe-write scaffold tier
          // (suspec_scaffold_spec / suspec_split_task). Never a verdict.
          mode: "read+reconcile+scaffold, no verdict",
          noVerdictIssued: true,
          store,
        },
        null,
        2,
      );
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
    },
  );

  server.registerResource(
    "status",
    "suspec://status",
    {
      title: "Suspec store summary",
      description:
        "The store summary — active + archived artifacts and the `next` attention ranking.",
      mimeType: JSON_MIME,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: body_of(invoke_suspec(ctx.env, "status")),
        },
      ],
    }),
  );

  server.registerResource(
    "checks",
    "suspec://checks",
    {
      title: "Checks contract",
      description: "The checks contract — version + the core checks.",
      mimeType: JSON_MIME,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: body_of(invoke_suspec(ctx.env, "show", ["checks"])),
        },
      ],
    }),
  );
}
