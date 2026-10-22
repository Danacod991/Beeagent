# Managed sync and recoverable reconciliation

Bee exports can serve two different jobs: retaining a local archive and supplying
the files a downstream tool actively reads. When a later scan no longer returns
a conversation, its retained Markdown file may still appear in local search.

Managed sync records the files it writes. It keeps absent exports until you
review a plan, then moves only unchanged, CLI-owned candidates to recoverable
quarantine. Local edits and unknown files are preserved. All changes are local;
this workflow never deletes records from Bee.

For a first look without a Bee account, run the
[synthetic search example](managed-search-example.md). Contributors can follow the
[maintainer review route](managed-sync-review.md).

## The four actions

Use one mode per output directory. For an existing ordinary export, keep it and
start managed mode in a **new directory**; existing files are not adopted just
because their names look like Bee exports. The legacy writer refuses managed
directories. Ordinary sync keeps its rendering and incremental behavior. Both
modes serialize cooperating writers and require a real output directory; a
symlink used as the output directory is rejected.

| Action | Effect on exported Markdown | Bee access |
| --- | --- | --- |
| `--managed` | Writes new exports and updates unedited owned files; retains absent paths. | Full scan |
| `--reconcile` | Saves a plan with candidate paths and preserved conflicts; leaves exports in place. | Full scan |
| `--apply PLAN_ID` | Revalidates the exact plan and moves eligible files to quarantine. | Fresh full scan |
| `--restore PLAN_ID` | Returns quarantined files to available original paths. | Offline |

Opening managed state also recovers an earlier interrupted operation, if one
exists. That recovery can finish previously authorized writes or moves before
the new action, including a preview or restore. See [recovery](#recover-after-an-interruption).

### 1. Export or refresh

```bash
bee sync --managed --output ./bee-managed-export
```

This scans all five Bee CLI 0.9.0 targets: facts, todos, daily summaries,
conversations and insights. Each insight uses the same Markdown format and
`insights/YYYY-MM-DD/ID.md` path as ordinary sync. A failed or incomplete insight
scan aborts the action, just as a failure for any other target does.

Repeat the same command to refresh. An owned file is updated only while its bytes
still match the recorded export; an unknown file or local edit is reported as a
conflict. Keep those changes or copy them to your own notes before resolving a
conflict deliberately.

Managed actions reject `--recent-days`, `--since`, `--only` and `--full`. Choose
exactly one of `--managed`, `--reconcile`, `--apply` or `--restore` per command.

**Aggregate files:** `facts.md` and `todos.md` each contain multiple entries.
Refreshing an unedited aggregate replaces it with the current complete export,
including changes or removals inside that file. Reconciliation handles obsolete
file paths; it does not provide entry-level version history or undo.

### 2. Review the plan

```bash
bee sync --reconcile --output ./bee-managed-export
```

Preview requires an existing managed inventory and prints JSON with an `id`,
`candidates` and `conflicts`. It saves the plan locally without moving or rewriting
exported Markdown, apart from any prior journal recovery described above.

Review the candidate paths before deciding to apply. A path is eligible only if
managed sync wrote it, its bytes are unchanged and the complete current scan no
longer projects that path. Absence does **not** establish server deletion: a
changed recording date may change its export path, or a source may be temporarily
unavailable. Unknown files are excluded; local edits become conflicts. A failed,
incomplete or invalid scan cannot create a new plan.

### 3. Apply that exact plan

Replace `PLAN_ID` with the ID from the reviewed preview:

```bash
bee sync --apply PLAN_ID --output ./bee-managed-export
```

Apply scans again and checks the remote export, local inventory, candidate bytes,
account, environment and output-directory binding. A changed snapshot, inventory
or candidate invalidates the plan. Generate and review a fresh plan; there is no
force option. An unrelated note outside the candidate set does not invalidate it.

Eligible files move out of the active export tree into private local quarantine.
Files edited after preview are not overwritten or silently discarded.

### 4. Restore locally

```bash
bee sync --restore PLAN_ID --output ./bee-managed-export
```

Restore needs no Bee request or fresh login. It validates the saved plan,
inventory, environment and output directory, then returns files to their original
paths without overwriting anything now there. An occupied destination remains a
conflict and its quarantined copy is retained. Make room deliberately before
retrying. Restoring historical bytes does not establish current availability in Bee.

## Recover after an interruption

Keep the export root and its private metadata together:

```text
.bee-managed/
├── inventory.json
├── plans/<plan-id>.json
├── quarantine/<plan-id>/<original-relative-path>
└── journal.json        # Present while an operation needs recovery
```

Internal staging and applied-plan records also belong to this state. Do not
hand-edit metadata or move plans between exports. Retry using the original
workspace, environment and plan ID. Opening managed storage first recovers a
pending journal; it refuses to overwrite a changed file or recovery destination
and preserves the journal when it cannot continue safely.

The `.bee-sync.lock` prevents cooperating sync writers from running together.
Wait for an active command. A matching lock from a process that no longer exists
can be reclaimed; ambiguous locks are refused. Follow the CLI's recovery message
rather than deleting metadata or running legacy sync to bypass a lock.

Stale-lock recovery uses a temporary `.bee-sync-reclaim.lock` directory so only
one process can reclaim a lock at a time. If it is busy, wait and retry. If an
interruption leaves it behind, the CLI reports that lock recovery needs manual
inspection; it never takes over based on the guard's age. Check that no sync
writer remains and preserve the workspace before investigating. Ordinary dead
writer locks still recover automatically; this extra inspection applies only
when reclamation itself was interrupted.

| Command stopped because… | Next step |
| --- | --- |
| No managed inventory exists | Start `--managed` in a new directory. |
| The remote export or inventory changed after preview | Create and review a new `--reconcile` plan. |
| A candidate changed locally | Preserve the edit and resolve it deliberately before making a new plan. |
| A restore destination is occupied | Keep both copies; make room only if you intend to, then retry. |
| A scan failed or reached a bound | Retry later or investigate the reported limit. A partial scan cannot justify reconciliation. |
| Account, environment or workspace validation failed | Return to the matching workspace; use a separate output directory for another account. |
| Lock recovery is in progress or interrupted | Wait and retry. If the reclamation guard persists, inspect active writers and the retained workspace; do not bypass it by blindly deleting metadata. |

## Privacy and operational limits

Keep the whole export private. Markdown may contain transcripts, names, summaries
and locations; metadata and plan paths can reveal identifiers. Quarantine retains
recoverable content. It is neither encryption nor secure erasure.

A consumer that should read only active exports must exclude `.bee-managed`.
Moving a file cannot invalidate an independent search index, model context,
application cache, backup or cloud-synced copy. Those consumers need their own
removal/reload policy. The [search example](managed-search-example.md) illustrates
a consumer that rereads only active conversation files.

Scans stop rather than produce a partial result at these bounds:

| Bound | Maximum |
| --- | --- |
| Request, including response body | 10 seconds |
| Complete scan | 120 seconds |
| Pages / records per target | 200 / 20,000 |
| Total requests | 25,000 |
| One response body | 16 MiB |
| All response bodies / formatted output | 64 MiB each |

Complete scans are not atomic server snapshots and do not reveal why a record is
absent. Large accounts may exceed the bounds. Filesystem checks currently cover
macOS with Bun 1.4.3; operations require local hard-link and directory-sync support.
Managed actions reject Windows before accessing Bee or creating managed state,
because the required directory synchronization is unavailable. Ordinary sync
remains available; its temporary lock cleanup does not require directory fsync
on Windows.

The synthetic suite does not establish live-account compatibility; record any
live checks separately with their account/runtime scope and without publishing
private exports. Other supported operating systems/filesystems, large-account
performance and physical power-loss recovery remain unverified. Journal and lock
checks cover ordinary interruption/retry, not a malicious concurrent process
running as the same local user.

## Verification

The [maintainer review route](managed-sync-review.md) maps the source boundaries,
focused tests and two compiled-CLI demos. Both demos use invented localhost data
and disposable configuration. They cover fresh search behavior, preserved edits,
stale-plan refusal, quarantine and exact offline restoration; they do not measure
live-account reliability or downstream adoption.
