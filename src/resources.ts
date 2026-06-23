// v0 resources — the application-driven context surface. Fixed URIs for the workspace board + the
// checks contract; templated URIs for individual artifacts (parsed via the `corpus show` loaders, the
// same data the get_* tools expose). All read-only; every templated id is validated before any
// subprocess. Findings have no parser, so they are served as raw markdown, labelled.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import { invoke_corpus, type CorpusResult } from "./corpus/invoke.ts";
import { confine_path, is_safe_segment, task_stem } from "./roots.ts";
import type { Ctx } from "./tools.ts";

const JSON_MIME = "application/json";

// Render a CorpusResult's payload as the resource body (the CLI data, or the structured error).
function body_of(result: CorpusResult): string {
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
    "corpus://workspace",
    {
      title: "Corpus workspace",
      description: "Workspace root, mode, and the current board summary.",
      mimeType: JSON_MIME,
    },
    (uri) => {
      const status = invoke_corpus(ctx.env, "status");
      const board = status.kind === "ok" ? status.data : null;
      const text = JSON.stringify(
        {
          workspaceRoot: ctx.root,
          mode: "read-only",
          noVerdictIssued: true,
          board,
        },
        null,
        2,
      );
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
    },
  );

  server.registerResource(
    "status",
    "corpus://status",
    {
      title: "Corpus board",
      description: "The derived workspace board — specs, tasks, reviews, gaps.",
      mimeType: JSON_MIME,
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: JSON_MIME,
          text: body_of(invoke_corpus(ctx.env, "status")),
        },
      ],
    }),
  );

  server.registerResource(
    "checks",
    "corpus://checks",
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
          text: body_of(invoke_corpus(ctx.env, "show", ["checks"])),
        },
      ],
    }),
  );

  // Templated artifact resources — the {id} is validated before the subprocess; an invalid id yields a
  // labelled error body rather than a thrown read.
  const stem_resource = (
    name: string,
    template: string,
    kind: "task" | "review",
  ): void => {
    server.registerResource(
      name,
      new ResourceTemplate(template, { list: undefined }),
      { title: name, mimeType: JSON_MIME },
      (uri, variables) => {
        const stem = task_stem(String(variables.id));
        const text = is_safe_segment(stem)
          ? body_of(invoke_corpus(ctx.env, "show", [kind, stem]))
          : JSON.stringify({
              error: "InvalidId",
              message: `invalid id: ${String(variables.id)}`,
            });
        return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
      },
    );
  };
  stem_resource("task", "corpus://tasks/{id}", "task");
  stem_resource("review", "corpus://reviews/{id}", "review");

  server.registerResource(
    "spec",
    new ResourceTemplate("corpus://specs/{id}", { list: undefined }),
    { title: "spec", mimeType: JSON_MIME },
    (uri, variables) => {
      const id = String(variables.id);
      const text = is_safe_segment(id)
        ? body_of(invoke_corpus(ctx.env, "show", ["spec", id]))
        : JSON.stringify({
            error: "InvalidId",
            message: `invalid spec id: ${id}`,
          });
      return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text }] };
    },
  );

  // Findings have no parser — serve the raw markdown, root-confined, clearly labelled unparsed. The id
  // is gated through `is_safe_segment` FIRST (like the task/spec/review templates), so confinement does
  // not depend on the SDK's URI-template capture semantics; `confine_path` then re-confirms as depth.
  server.registerResource(
    "finding",
    new ResourceTemplate("corpus://findings/{id}", { list: undefined }),
    { title: "finding", mimeType: "text/markdown" },
    (uri, variables) => {
      const id = String(variables.id);
      if (!is_safe_segment(id)) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: JSON_MIME,
              text: JSON.stringify({
                error: "InvalidId",
                message: `invalid finding id: ${id}`,
              }),
            },
          ],
        };
      }
      const safe = confine_path(ctx.root, join("findings", `${id}.md`));
      /* v8 ignore next 3 -- defence in depth: is_safe_segment already rejects every `..`/separator/
           flag-shaped id, so a safe segment always confines; this arm guards a non-template future caller. */
      if (safe === null) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: JSON_MIME,
              text: JSON.stringify({
                error: "InvalidId",
                message: `invalid finding id: ${id}`,
              }),
            },
          ],
        };
      }
      const path = join(ctx.root, safe);
      const text = existsSync(path)
        ? readFileSync(path, "utf8")
        : `(no finding ${id})`;
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );
}
