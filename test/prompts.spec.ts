import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { create_server } from "../src/server.ts";

// The prompts shape the agent; the key property is the deliberate before-done / review-assistant
// ASYMMETRY (the honesty lever for the laundering tension) + that NO prompt grants verdict authority.
async function connect(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = create_server({
    env: { bin: "suspec", cwd: "/tmp" },
    root: "/tmp",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function promptText(result: {
  messages: { content: { type: string; text?: string } }[];
}): string {
  return result.messages
    .map((m) => (m.content.type === "text" ? (m.content.text ?? "") : ""))
    .join("\n");
}

describe("suspec-mcp prompts", () => {
  it("lists the three v2 prompts (task_briefing / finding_candidate retired with their tools)", async () => {
    const { client, close } = await connect();
    try {
      const names = (await client.listPrompts()).prompts
        .map((p) => p.name)
        .sort();
      expect(names).toEqual(
        [
          "suspec_before_done",
          "suspec_evidence_rule",
          "suspec_review_assistant",
        ].sort(),
      );
    } finally {
      await close();
    }
  });

  it("before_done points at reconcile + evidence capture and tells the implementer it cannot close the gate", async () => {
    const { client, close } = await connect();
    try {
      const r = (await client.getPrompt({
        name: "suspec_before_done",
        arguments: { run: "demo" },
      })) as {
        messages: { content: { type: string; text?: string } }[];
      };
      const text = promptText(r);
      expect(text).toMatch(/suspec_reconcile/);
      expect(text).toMatch(/suspec evidence add demo/);
      expect(text).toMatch(/may not close the gate|suspec done.*human/i);
      expect(text).toMatch(/Unverified/);
    } finally {
      await close();
    }
  });

  it("review_assistant tells the reviewer to falsify, not trust, and not to review own work", async () => {
    const { client, close } = await connect();
    try {
      const r = (await client.getPrompt({
        name: "suspec_review_assistant",
        arguments: { run: "demo" },
      })) as {
        messages: { content: { type: string; text?: string } }[];
      };
      const text = promptText(r);
      expect(text).toMatch(/did NOT author|not author/i);
      expect(text).toMatch(/falsify|not a result to trust/i);
      expect(text).toMatch(/do not approve/i);
      expect(text).toMatch(/cli-verified/);
    } finally {
      await close();
    }
  });

  it("evidence_rule pins the v2 rule: only fresh cli-verified capture counts", async () => {
    const { client, close } = await connect();
    try {
      const r = (await client.getPrompt({
        name: "suspec_evidence_rule",
        arguments: {},
      })) as {
        messages: { content: { type: string; text?: string } }[];
      };
      const text = promptText(r);
      expect(text).toMatch(/a claim is not evidence/i);
      expect(text).toMatch(/cli-verified/);
      expect(text).toMatch(/suspec done/);
    } finally {
      await close();
    }
  });

  it('no prompt grants verdict authority (no "you may approve/merge/pass")', async () => {
    const { client, close } = await connect();
    try {
      for (const p of (await client.listPrompts()).prompts) {
        const args =
          p.arguments && p.arguments.length > 0 ? { run: "demo" } : {};
        const r = (await client.getPrompt({
          name: p.name,
          arguments: args,
        })) as {
          messages: { content: { type: string; text?: string } }[];
        };
        // a prompt may discuss NOT approving ("you may NOT close the gate"), but must never GRANT the
        // authority — so the patterns match grant-forms only, with a lookbehind excluding negations.
        expect(promptText(r)).not.toMatch(
          /\byou (may|can|should) (?!not\b)(approve|merge|pass|close the gate)\b|(?<!not )\bmerge it\b|\bgo ahead and (approve|merge)\b|\brecord (a )?pass\b/i,
        );
      }
    } finally {
      await close();
    }
  });
});
