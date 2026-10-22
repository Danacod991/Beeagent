#!/usr/bin/env node
// Wellness signal minimizer
//
// Connects to the local Bee MCP server (`bee mcp serve`, stdio), searches recent
// conversations for a few everyday wellness terms, and prints ONLY coarse,
// aggregated signals (signal name + approximate mention count).
//
// No transcript text, no conversation IDs and no timestamps are ever printed.
// This is the "minimize before you share" step that should sit between Bee's
// private context and anything that leaves the machine.

import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SIGNAL_TERMS = {
  tiredness: ["tired", "exhausted", "worn out", "fatigue"],
  poor_sleep: ["slept badly", "couldn't sleep", "insomnia", "poor sleep"],
  dizziness: ["dizzy", "lightheaded"],
  low_appetite: ["not hungry", "skipped lunch", "no appetite"],
};

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "3" },
    command: { type: "string", default: "bee" },
    debug: { type: "boolean", default: false },
  },
});

const days = Number.parseInt(values.days, 10);
if (!Number.isFinite(days) || days < 1 || days > 30) {
  console.error("--days must be an integer between 1 and 30");
  process.exit(2);
}

/** Pull the list of hits out of a tool result without assuming one exact shape. */
function extractItems(result) {
  const candidate =
    result.structuredContent ??
    (() => {
      const text = (result.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();

  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === "object") {
    for (const value of Object.values(candidate)) {
      if (Array.isArray(value)) return value;
    }
  }
  return null; // unknown shape
}

const transport = new StdioClientTransport({
  command: values.command,
  args: ["mcp", "serve"],
});
const client = new Client({ name: "wellness-signal-minimizer", version: "0.1.0" });

try {
  await client.connect(transport);

  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const signals = [];

  for (const [signal, terms] of Object.entries(SIGNAL_TERMS)) {
    const seen = new Set();
    let unnamedHits = 0;
    let shapeKnown = true;

    for (const term of terms) {
      const result = await client.callTool({
        name: "bee_search",
        arguments: {
          query: term,
          filter: "conversations",
          mode: "keyword",
          since,
          limit: 20,
        },
      });

      if (values.debug) {
        // Debug output is for adapting the parser. It stays on stderr and is
        // limited to the structure, not the content.
        console.error(
          `[debug] ${signal}/${term}: keys=${Object.keys(result).join(",")}`,
        );
      }

      const items = extractItems(result);
      if (items === null) {
        shapeKnown = false;
        continue;
      }
      for (const item of items) {
        const id = item && typeof item === "object" ? (item.id ?? item.conversation_id) : undefined;
        if (id !== undefined) seen.add(String(id));
        else unnamedHits += 1;
      }
    }

    signals.push({
      signal,
      mentions: shapeKnown ? seen.size + unnamedHits : null,
    });
  }

  const output = {
    windowDays: days,
    signals: signals.filter((s) => s.mentions === null || s.mentions > 0),
    note: "Aggregated keyword counts only. No transcript text is included. Not a diagnosis.",
  };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(
    `Could not read Bee context: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error('If you are not signed in, run "bee login" first.');
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
