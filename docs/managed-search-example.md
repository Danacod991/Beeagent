# Synthetic example: control what a local export search reads

A retained Bee export is useful as an archive. The same file can be surprising
input to a local search tool when a later Bee scan no longer returns its source.
This example makes that difference visible with an invented question:

> Why does Venus show phases through a telescope?

The compiled CLI exports the question, retains it on refresh, previews its
reconciliation, quarantines it and restores it offline. A tiny search consumer
rereads the active conversation files after each step.

## Run without a Bee account

From this source checkout, with Bun installed:

```bash
bun install --frozen-lockfile
bun run build
bun scripts/demo-managed-search.ts
```

No Bee login is needed. The script starts an invented localhost fixture, uses a
separate temporary configuration and export directory, and removes both when it
finishes. Each compiled CLI invocation has a 20-second deadline. Dependency
installation may access the package registry; the example's API requests stay
on localhost. It makes no requests to a real Bee account.

Expect this progression, followed by a `PASS` summary:

| Stage | What the CLI does | Active search matches |
| --- | --- | --- |
| Initial export | Writes the invented conversation. | **1** |
| Fixture omits it; managed refresh | Retains the old export. | **1** |
| Preview | Saves a plan without moving the export. | **1** |
| Apply | Rescans, validates the plan and quarantines the unchanged file. | **0** |
| Offline restore | With the fixture stopped, returns the exact original bytes. | **1** |

To retain a machine-readable report instead of terminal narration:

```bash
bun scripts/demo-managed-search.ts --json > managed-sync-report.json
```

The report records the same synthetic stage results and checks, plus source and
binary hashes. It is emitted only after successful assertions and temporary-file
cleanup. Your shell saves it at the specified path; it is not part of the removed
workspace. See the [review route](managed-sync-review.md) for additional checks.

The script checks the candidate's path and hash before automatically applying its
synthetic plan. This is an assertion-driven demonstration, not a human-reviewed
plan. In normal use, inspect the preview before choosing to apply it. The
[managed sync guide](managed-sync.md) gives the real command sequence, conflict
handling and recovery instructions.

## What the consumer includes

Each search reads regular Markdown files under
`conversations/YYYY-MM-DD/ID.md`. It excludes `.bee-managed`, including quarantine,
and keeps no persistent index or application cache.

An edited second export and an unrelated `notes.md` must survive every step. The
note and an exported insight deliberately repeat the Venus question but fall
outside the search scope. Zero matches therefore means no matching **active
conversation files**, while the note, insight and recoverable quarantined copy
still exist.

This is the behavior a fresh-file consumer can reproduce. Existing search indexes,
model context, backups and independently retained files need their own update or
removal policy; reconciliation does not invalidate them or securely erase content.

Managed sync also covers facts, todos, daily summaries and insights. This example
searches conversations only, so its match counts do not measure those other
exports. The [maintainer review route](managed-sync-review.md) includes a second
compiled-CLI demo that exercises both conversation and insight quarantine and
offline restoration.

## Interpret the result

The fixture deliberately omits a record. That proves absence in the staged scan,
not server deletion or its cause. Offline restore recovers historical local
bytes, not proof that Bee returns that record again. Keep the synthetic label
visible when sharing the example. It does not establish live-account behavior,
customer adoption or production integration.

For stale-plan refusal and maintainer checks, continue to the
[review route](managed-sync-review.md).
