# Wellness signal minimizer

An example of using Bee's MCP server as a **privacy boundary**: read private Bee context locally, and emit only coarse, aggregated signals that are safe to hand to another system.

Bee captures what a person says throughout the day. That is exactly what makes it useful for wellness awareness ("I've felt more tired than usual"), and exactly why raw transcripts should never be forwarded to a family member, a dashboard, or an LLM prompt by default. This example shows the smallest useful pattern: **search locally, count, and drop the text.**

> This example does not diagnose anything and is not a medical tool. It counts keyword mentions.

## What it does

1. Starts the Bee MCP server over stdio (`bee mcp serve`) using the stored Bee login. No extra token is needed.
2. Calls the documented `bee_search` tool with `filter: "conversations"`, `mode: "keyword"` and a `since` bound for each term in a small vocabulary (tiredness, poor sleep, dizziness, low appetite).
3. Prints one JSON object with, per signal, the approximate number of conversations that mention it.

It never prints transcript text, conversation content, or timestamps. Conversation IDs, when present, are used only to avoid double counting and are not printed.

## Prerequisites

* Bee CLI installed and signed in (`bee login`).
* Node.js 18 or newer, or Bun.

## Run it

```bash
cd examples/wellness-signal-minimizer
npm install
node index.mjs --days 3
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--days` | `3` | How many days back to search (1 to 30). |
| `--command` | `bee` | Path to the Bee CLI binary. |
| `--debug` | off | Prints only the *structure* of each tool result to stderr, to help adapt the parser. |

## Example output

The values below are illustrative.

```json
{
  "windowDays": 3,
  "signals": [
    { "signal": "tiredness", "mentions": 2 },
    { "signal": "poor_sleep", "mentions": 3 }
  ],
  "note": "Aggregated keyword counts only. No transcript text is included. Not a diagnosis."
}
```

If the result shape of `bee_search` is not what the script expects, `mentions` is reported as `null` rather than guessed. Run with `--debug` to see which keys the result contains.

## Where this fits

The output is small enough to pass to a consent layer. A real-world use of this idea is [CarePulse](https://github.com/LucioD3v/Care_Pulse), an Alexa skill with an MCP server where a caregiver is notified only under an explicit, scoped, expiring consent. A minimizer like this sits upstream of such a gate: whatever the gate allows can only ever contain signals, never conversations.

## Design notes

* **Local first.** The server runs on the user's machine and reuses the existing Bee login, as described in the MCP docs.
* **Minimize at the source.** Reduce data to the least informative form that still answers the question, before it reaches any other component.
* **Honest uncertainty.** Unknown result shapes produce `null`, not a guess.
* **Easy to extend.** Edit `SIGNAL_TERMS` in `index.mjs`, or switch to `mode: "semantic"` for fuzzier matching.

## Limitations

* Keyword matching misses phrasing and can match unrelated uses of a word.
* Counts are per conversation and approximate.
* Nothing here replaces professional or emergency care.
