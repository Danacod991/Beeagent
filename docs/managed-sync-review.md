# Maintainer review route: managed exports

This opt-in extension separates retaining an export from choosing what stays in
its active file tree. Ordinary sync keeps its incremental behavior. Managed sync
tracks the files it writes; an explicit preview/apply flow can quarantine an
absent, unchanged export, and offline restore can recover it.

The contribution targets Bee CLI 0.9.0 and covers all five export targets: facts,
todos, daily summaries, conversations and insights. The port is based on upstream
commit `fa9580d104b0c88054e9649b1e256fd19eb0895a`; it retains the upstream insight
changefeed implementation for ordinary incremental sync.

Both modes now serialize cooperating writers and require a real output directory;
an output path that is itself a symlink is refused. Ordinary sync also refuses
managed directories so it cannot bypass inventory ownership checks.

## First look: run the consumer example

From a source checkout with Bun installed:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun scripts/demo-managed-search.ts
```

The example launches `dist/bee` against invented localhost data, with disposable
configuration and exports. It does not require a Bee account or use an existing
authentication cache. Each child command is bounded to 20 seconds; assertion
failure exits unsuccessfully. The [walkthrough](managed-search-example.md) explains
the fixture and consumer scope.

The expected active-search counts are **1 → 1 → 1 → 0 → 1**: initial export,
retained absent export, unchanged preview, applied quarantine, offline restore.
An edited export and a matching unrelated note survive. Quarantine retains the
original bytes; the result is a changed fresh-file search, not cache invalidation.

To save the same checks as machine-readable evidence after building:

```bash
bun scripts/demo-managed-search.ts --json > managed-sync-report.json
```

Success emits one JSON report after assertions and temporary-file cleanup. It
records the synthetic scope, stage results, preservation and restoration checks,
plus source and binary hashes. A report identifies what ran; its hashes alone
do not prove that the binary was built from the checkout. The output file is
written by your shell, outside the demo's cleanup, and can be retained for review.

## Review the failure and recovery paths

```bash
bun test sources/commands/sync
bun scripts/demo-managed-sync.ts
```

These commands use fixtures and temporary files. The second demo exercises the
compiled CLI, rejects a plan after a staged remote change, applies a fresh plan
for absent conversation and insight files, then restores with the fixture server
stopped. A successful run reports `PASS` for preview preservation, stale-plan
refusal, quarantine and offline recovery.

| Review concern | Source and tests |
| --- | --- |
| Exclusive actions; reject filtered scans; JSON reports | [command.ts](../sources/commands/sync/managed/command.ts), [command.test.ts](../sources/commands/sync/managed/command.test.ts) |
| Identity checks; complete pagination; validated shapes; request/body/scan bounds | [snapshot.ts](../sources/commands/sync/managed/snapshot.ts), [snapshot.test.ts](../sources/commands/sync/managed/snapshot.test.ts) |
| Inventory ownership; exact plan binding; conflicts; quarantine; restore; locks and paths | [storage.ts](../sources/commands/sync/managed/storage.ts), [storage.test.ts](../sources/commands/sync/managed/storage.test.ts) |
| Markdown byte compatibility for all five targets; insight quarantine and restore; workflow integration | [integration.test.ts](../sources/commands/sync/managed/integration.test.ts), [index.test.ts](../sources/commands/sync/index.test.ts) |
| Child-process interruption after selected filesystem operations; offline byte-exact recovery | [process.test.ts](../sources/commands/sync/managed/process.test.ts) |
| Windows managed-action refusal before API/state access; ordinary sync and dead-lock cleanup without directory fsync | [platform.test.ts](../sources/commands/sync/managed/platform.test.ts) |

Useful checks while reading the implementation:

- Only files actually written by managed sync become owned. Unknown paths and
  local edits survive; the legacy writer cannot overwrite a managed workspace.
- Preview leaves exports in place. Apply rescans and refuses a changed snapshot,
  inventory, candidate, account, environment, output root or plan.
- Restoration never overwrites an occupied destination. Journal recovery may
  finish a prior authorized operation when managed state is next opened, even
  for a new preview or restore.

The existing renderers are reused. Facts and todos remain aggregate files:
refresh can replace entries inside an unedited aggregate; reconciliation is
file-level, not entry-level history.

For insights, managed scans consume the complete records returned by paginated
`GET /v1/insights`; they do not issue per-insight detail requests. Validation
covers the fields consumed by the renderer, including suggested actions,
corrections and the timestamp/timezone used for the destination date. A missing
endpoint, incomplete pagination or malformed insight aborts the complete scan;
none is treated as an empty insight list. The ordinary sync renderer supplies
the Markdown bytes and `insights/YYYY-MM-DD/ID.md` path.

## Scope to keep in review

The automated tests and demos use invented data on macOS with Bun 1.4.3.
Record live-account checks separately: use a fresh private output directory,
repeat `--managed`, then run `--reconcile` and verify that preview preserves
export and inventory bytes. Do not apply a plan just to establish compatibility.
A successful run covers that account and runtime; it does not establish other
filesystems, large-account performance or physical power-loss recovery. The
current scan bounds and private-state handling are in
[managed sync](managed-sync.md#privacy-and-operational-limits).

Managed mode explicitly rejects Windows because its journal requires durable
directory synchronization. The platform regression tests simulate Windows and a
directory-fsync failure in isolated child processes; they check that ordinary
sync and dead-lock reclamation still work and that managed actions refuse before
requests or state creation. These checks do not establish actual Windows runtime
compatibility.

A completed scan is not an atomic server snapshot, and missing a record does not
prove deletion. Quarantine is recoverable private content, so consumers must
exclude `.bee-managed` and handle their own indexes/caches.
