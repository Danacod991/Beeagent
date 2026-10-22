import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, link, rmdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const META = ".bee-managed";
const LOCK = ".bee-sync.lock";
const RECLAIM_LOCK = ".bee-sync-reclaim.lock";
const MAX_FILES = 50_000;
const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{32}$/;

export type ManagedBinding = { accountHash: string; env: string };
export type ManagedExport = { path: string; content: string };
export type StorageConflict = { path: string; reason: "untracked" | "modified" | "missing" | "occupied" };
type Bound = ManagedBinding & { root: string };
type Inventory = Bound & { version: 1; revision: number; files: Record<string, string> };
export type ReconcilePlan = {
  id: string;
  createdAt: string;
  snapshotDigest: string;
  inventoryRevision: number;
  candidates: { path: string; hash: string }[];
  conflicts: StorageConflict[];
};
type StoredPlan = ReconcilePlan & Bound & { version: 1 };
export type SyncResult = { written: number; unchanged: number; conflicts: StorageConflict[] };
export type ApplyResult = { planId: string; quarantined: number; alreadyApplied: boolean };
export type RestoreResult = { planId: string; restored: number; conflicts: StorageConflict[] };
type Operation =
  | { kind: "write"; path: string; hash: string; previous: string | null; stage: string }
  | { kind: "quarantine" | "restore"; path: string; hash: string };
type Journal = Bound & {
  version: 1;
  id: string;
  kind: "sync" | "apply" | "restore";
  planId: string | null;
  base: Inventory;
  target: Inventory;
  operations: Operation[];
};
type Regular = { hash: string; ino: number; dev: number; nlink: number };

function fail(message: string): never { throw new Error(message); }
export function assertManagedPlatform(): void {
  if (process.platform === "win32") {
    fail("Managed sync is not supported on Windows: durable directory synchronization is required. Ordinary sync remains available.");
  }
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function encode(value: unknown): string { return JSON.stringify(value); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid managed metadata.");
  return value as Record<string, unknown>;
}
function relative(value: unknown): string {
  if (typeof value !== "string" || !/^(?:(?:facts|todos)\.md|daily\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/summary\.md|(?:conversations|insights)\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[1-9][0-9]{0,23}\.md)$/.test(value)) {
    fail("Unsafe or unsupported managed export path.");
  }
  return value;
}
function identity(value: ManagedBinding): void {
  if (!/^[a-f0-9]{16,64}$/.test(value.accountHash) || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.env)) {
    fail("Managed sync requires a stable account fingerprint and environment.");
  }
}
function bound(value: unknown, expected: Bound): void {
  const data = record(value);
  if (data["root"] !== expected.root || data["accountHash"] !== expected.accountHash || data["env"] !== expected.env) {
    fail("Managed output belongs to a different root, account, or environment.");
  }
}
function inventory(value: unknown, expected: Bound): Inventory {
  bound(value, expected);
  const data = record(value);
  if (data["version"] !== 1 || !Number.isSafeInteger(data["revision"]) || (data["revision"] as number) < 0) fail("Invalid managed inventory.");
  const files = record(data["files"]);
  if (Object.keys(files).length > MAX_FILES) fail("Managed inventory exceeds its limit.");
  for (const [name, hash] of Object.entries(files)) {
    relative(name);
    if (typeof hash !== "string" || !HASH.test(hash)) fail("Invalid managed inventory hash.");
  }
  return value as Inventory;
}
function plan(value: unknown, expected: Bound, id: string): StoredPlan {
  bound(value, expected);
  const data = record(value);
  if (data["version"] !== 1 || data["id"] !== id || !HASH.test(String(data["snapshotDigest"])) ||
      !Number.isSafeInteger(data["inventoryRevision"]) || !Array.isArray(data["candidates"]) ||
      data["candidates"].length > MAX_FILES || !Array.isArray(data["conflicts"]) || data["conflicts"].length > MAX_FILES ||
      typeof data["createdAt"] !== "string" || !Number.isFinite(Date.parse(data["createdAt"]))) fail("Invalid reconciliation plan.");
  const names = new Set<string>();
  for (const item of data["candidates"]) {
    const entry = record(item);
    const name = relative(entry["path"]);
    if (names.has(name)) fail("Duplicate reconciliation candidate.");
    names.add(name);
    if (!HASH.test(String(entry["hash"]))) fail("Invalid reconciliation candidate.");
  }
  for (const item of data["conflicts"]) {
    const entry = record(item);
    relative(entry["path"]);
    if (!["untracked", "modified", "missing", "occupied"].includes(String(entry["reason"]))) fail("Invalid reconciliation conflict.");
  }
  const { id: _id, ...payload } = data;
  if (digest(encode(payload)).slice(0, 32) !== id) fail("Reconciliation plan changed after preview.");
  return value as StoredPlan;
}

async function statOrNull(file: string) {
  try { return await lstat(file); } catch (error) { if (code(error) === "ENOENT") return null; throw error; }
}
async function directory(file: string, create = false): Promise<void> {
  let stat = await statOrNull(file);
  if (!stat && create) {
    try { await mkdir(file, { mode: 0o700 }); } catch (error) { if (code(error) !== "EEXIST") throw error; }
    stat = await statOrNull(file);
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail("Managed path contains an unsafe directory.");
}
async function resolveRoot(outputDir: string): Promise<string> {
  const requested = path.resolve(outputDir);
  const stat = await statOrNull(requested);
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) fail("Sync output must be a real directory.");
  if (!stat) await mkdir(requested, { recursive: true, mode: 0o700 });
  await directory(requested);
  return realpath(requested);
}
async function rootStillSafe(root: string): Promise<void> {
  await directory(root);
  if (await realpath(root) !== root) fail("Sync output changed during the operation.");
}
async function checked(root: string, name: string, createParents = false): Promise<string> {
  await rootStillSafe(root);
  const parts = name.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (!part || part === "." || part === "..") fail("Unsafe managed path.");
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat && !createParents) return path.join(root, name);
    await directory(current, createParents);
  }
  return path.join(root, name);
}
async function regular(root: string, name: string, allowLinks = false): Promise<Regular | null> {
  const file = await checked(root, name);
  const before = await statOrNull(file);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || (!allowLinks && before.nlink !== 1) || before.size > MAX_BYTES) {
    fail("Managed path is not a safe bounded regular file.");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > MAX_BYTES) fail("Managed file changed while opening.");
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (contents.length > MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("Managed file changed while reading.");
    return { hash: createHash("sha256").update(contents).digest("hex"), ino: after.ino, dev: after.dev, nlink: after.nlink };
  } finally { await handle.close(); }
}
async function readJson(root: string, name: string): Promise<unknown> {
  const file = await checked(root, name);
  const safe = await regular(root, name);
  if (!safe) fail("Required managed metadata is missing.");
  // The metadata directory is private and all cooperating operations hold the lock.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile("utf8")) as unknown; }
  catch { fail("Managed metadata is unreadable or invalid."); }
  finally { await handle.close(); }
}
async function syncDir(file: string): Promise<void> {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
// Lock files are coordination state, not a durable data journal. Windows cannot
// fsync a directory opened this way; skipping only lock-directory flushes keeps
// ordinary sync available without relaxing managed metadata durability.
async function syncLockDir(root: string): Promise<void> {
  if (process.platform !== "win32") await syncDir(root);
}
async function atomic(root: string, name: string, contents: string): Promise<void> {
  const destination = await checked(root, name, true);
  await regular(root, name);
  const temporary = destination + ".tmp-" + randomBytes(8).toString("hex");
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await checked(root, name);
    await regular(root, name);
    await rename(temporary, destination);
    await syncDir(path.dirname(destination));
  } finally { await unlink(temporary).catch(error => { if (code(error) !== "ENOENT") throw error; }); }
}
async function removeMetadata(root: string, name: string): Promise<void> {
  const file = await checked(root, name);
  if (await regular(root, name)) { await unlink(file); await syncDir(path.dirname(file)); }
}
function exportsMap(exports: ManagedExport[]): Map<string, { content: string; hash: string }> {
  if (!Array.isArray(exports) || exports.length > MAX_FILES) fail("Managed snapshot exceeds its file limit.");
  const result = new Map<string, { content: string; hash: string }>();
  let total = 0;
  for (const entry of exports) {
    const name = relative(entry.path);
    if (result.has(name) || typeof entry.content !== "string") fail("Managed snapshot contains duplicate or invalid exports.");
    const size = Buffer.byteLength(entry.content);
    total += size;
    if (size > MAX_BYTES || total > 256 * 1024 * 1024) fail("Managed snapshot exceeds its content limit.");
    result.set(name, { content: entry.content, hash: digest(entry.content) });
  }
  return new Map([...result].sort(([a], [b]) => a.localeCompare(b)));
}
function snapshotDigest(exports: Map<string, { hash: string }>): string {
  return digest(encode([...exports].map(([name, value]) => [name, value.hash])));
}

export interface ManagedStorage {
  sync(exports: ManagedExport[]): Promise<SyncResult>;
  preview(exports: ManagedExport[]): Promise<ReconcilePlan>;
  apply(planId: string, freshExports: ManagedExport[]): Promise<ApplyResult>;
  restore(planId: string): Promise<RestoreResult>;
}
export interface LockedSyncOutput {
  assertLegacyAllowed(): Promise<void>;
  managed(binding: ManagedBinding, options?: { create?: boolean }): Promise<ManagedStorage>;
  localManaged(env: string): Promise<Pick<ManagedStorage, "restore">>;
}

class Storage implements ManagedStorage {
  constructor(private readonly binding: Bound, private current: Inventory, private readonly guard: () => void) {}
  private async loadPlan(id: string): Promise<StoredPlan> {
    if (!ID.test(id)) fail("Invalid reconciliation plan ID.");
    return plan(await readJson(this.binding.root, `${META}/plans/${id}.json`), this.binding, id);
  }
  private async commit(journal: Journal): Promise<void> {
    await atomic(this.binding.root, `${META}/journal.json`, encode(journal));
    await this.recover();
  }
  async recover(): Promise<void> {
    this.guard();
    const root = this.binding.root;
    if (!await regular(root, `${META}/journal.json`)) return;
    const raw = record(await readJson(root, `${META}/journal.json`));
    bound(raw, this.binding);
    if (raw["version"] !== 1 || !ID.test(String(raw["id"])) ||
        !["sync", "apply", "restore"].includes(String(raw["kind"])) ||
        !Array.isArray(raw["operations"]) || raw["operations"].length > MAX_FILES ||
        !(raw["planId"] === null || ID.test(String(raw["planId"])))) fail("Invalid recovery journal.");
    const base = inventory(raw["base"], this.binding);
    const target = inventory(raw["target"], this.binding);
    if (target.revision !== base.revision + 1) fail("Invalid recovery inventory revision.");
    const journal = raw as unknown as Journal;
    if (encode(this.current) !== encode(base) && encode(this.current) !== encode(target)) fail("Recovery inventory no longer matches the journal.");
    const expectedFiles = { ...base.files };
    const seen = new Set<string>();
    const approved = journal.kind === "sync" ? null : await this.loadPlan(journal.planId ?? "");
    if (journal.kind === "sync" && journal.planId !== null) fail("Invalid sync recovery plan.");
    for (const value of journal.operations) {
      const item = record(value);
      const name = relative(item["path"]);
      const hash = item["hash"];
      if (typeof hash !== "string" || !HASH.test(hash) || seen.has(name)) fail("Invalid recovery file identity.");
      seen.add(name);
      if (journal.kind === "sync") {
        if (item["kind"] !== "write" ||
            !(item["previous"] === null ? expectedFiles[name] === undefined : expectedFiles[name] === item["previous"]) ||
            typeof item["stage"] !== "string" || !item["stage"].startsWith(journal.id + "-")) fail("Recovery write is not bound to owned inventory.");
        expectedFiles[name] = hash;
      } else {
        if (!approved?.candidates.some(candidate => candidate.path === name && candidate.hash === hash)) fail("Recovery file is not in its approved plan.");
        if (journal.kind === "apply") {
          if (item["kind"] !== "quarantine" || expectedFiles[name] !== hash) fail("Recovery quarantine is not owned.");
          delete expectedFiles[name];
        } else {
          if (item["kind"] !== "restore" || (expectedFiles[name] !== undefined && expectedFiles[name] !== hash)) fail("Recovery restore conflicts with inventory.");
          expectedFiles[name] = hash;
        }
      }
    }
    if (encode(expectedFiles) !== encode(target.files)) fail("Recovery target does not match its operations.");
    if (encode(this.current) === encode(base)) {
      for (const operation of journal.operations) {
        relative(operation.path);
        if (!HASH.test(operation.hash)) fail("Invalid recovery file hash.");
        const destination = await checked(root, operation.path, true);
        if (operation.kind === "write") {
          if (!/^[a-f0-9]{32}-[0-9]+$/.test(operation.stage) ||
              !(operation.previous === null || HASH.test(operation.previous))) fail("Invalid staged export.");
          const stageName = `${META}/staged/${operation.stage}`;
          const stage = await checked(root, stageName);
          let saved = await regular(root, operation.path, true);
          const staged = await regular(root, stageName, true);
          if (saved?.hash === operation.hash && saved.nlink === 1 && !staged) {
            await syncDir(path.dirname(destination));
            await syncDir(path.dirname(stage));
            continue;
          }
          if (saved && staged && saved.ino === staged.ino && saved.dev === staged.dev && saved.hash === operation.hash && saved.nlink === 2 && staged.nlink === 2) {
            await syncDir(path.dirname(destination));
            await unlink(stage); await syncDir(path.dirname(stage)); continue;
          }
          if (!staged || staged.hash !== operation.hash || staged.nlink !== 1 ||
              (saved && saved.nlink !== 1)) fail("Staged export changed; recovery requires local review.");
          if (operation.previous === null) {
            if (saved) fail("An untracked file occupies a pending export; it was preserved.");
            await link(stage, destination);
            await syncDir(path.dirname(destination));
            await unlink(stage);
          } else {
            if (!saved || saved.hash !== operation.previous) fail("An owned export changed; recovery preserved it.");
            await rename(stage, destination);
          }
          await syncDir(path.dirname(destination));
          await syncDir(path.dirname(stage));
        } else if (operation.kind === "quarantine" || operation.kind === "restore") {
          if (!journal.planId) fail("Recovery plan ID is missing.");
          const quarantineName = `${META}/quarantine/${journal.planId}/${operation.path}`;
          const quarantined = await checked(root, quarantineName, true);
          const fromName = operation.kind === "quarantine" ? operation.path : quarantineName;
          const toName = operation.kind === "quarantine" ? quarantineName : operation.path;
          const from = operation.kind === "quarantine" ? destination : quarantined;
          const to = operation.kind === "quarantine" ? quarantined : destination;
          const source = await regular(root, fromName, true);
          const existing = await regular(root, toName, true);
          if (!source && existing?.hash === operation.hash && existing.nlink === 1) {
            await syncDir(path.dirname(from));
            await syncDir(path.dirname(to));
            continue;
          }
          if (!source || source.hash !== operation.hash) fail("A recovery source changed; no file was removed.");
          if (existing) {
            if (existing.ino !== source.ino || existing.dev !== source.dev || existing.hash !== operation.hash || source.nlink !== 2 || existing.nlink !== 2) {
              fail("A recovery destination is occupied; both files were preserved.");
            }
          } else {
            if (source.nlink !== 1) fail("Hard-linked managed files are unsupported.");
            await link(from, to);
            await syncDir(path.dirname(to));
          }
          await syncDir(path.dirname(to));
          await unlink(from);
          await syncDir(path.dirname(from));
        } else fail("Invalid recovery operation.");
      }
      await atomic(root, `${META}/inventory.json`, encode(target));
      this.current = target;
    }
    if (journal.kind === "apply" && journal.planId) {
      await atomic(root, `${META}/applied/${journal.planId}.json`, encode({ version: 1, ...this.binding, id: journal.planId }));
    }
    await removeMetadata(root, `${META}/journal.json`);
  }
  async sync(exports: ManagedExport[]): Promise<SyncResult> {
    this.guard();
    const wanted = exportsMap(exports);
    const files = { ...this.current.files };
    const operations: Extract<Operation, { kind: "write" }>[] = [];
    const conflicts: StorageConflict[] = [];
    const id = randomBytes(16).toString("hex");
    let unchanged = 0;
    for (const [name, value] of wanted) {
      const previous = this.current.files[name];
      const saved = await regular(this.binding.root, name);
      if (saved && previous === undefined) { conflicts.push({ path: name, reason: "untracked" }); continue; }
      if (previous !== undefined && (!saved || saved.hash !== previous)) {
        conflicts.push({ path: name, reason: saved ? "modified" : "missing" }); continue;
      }
      if (saved?.hash === value.hash) { unchanged++; continue; }
      const stage = `${id}-${operations.length}`;
      operations.push({ kind: "write", path: name, hash: value.hash, previous: previous ?? null, stage });
      files[name] = value.hash;
    }
    // Validate every destination before copying any captured content. Stage
    // files are private and become recoverable only once the journal exists.
    const staged: string[] = [];
    try {
      for (const operation of operations) {
        const name = `${META}/staged/${operation.stage}`;
        const destination = await checked(this.binding.root, name, true);
        const handle = await open(destination, "wx", 0o600);
        // Track only files created by this operation, including a partial write.
        staged.push(name);
        try {
          await handle.writeFile(wanted.get(operation.path)!.content, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        await syncDir(path.dirname(destination));
      }
      if (operations.length) await this.commit({ version: 1, ...this.binding, id, kind: "sync", planId: null,
        base: this.current, target: { ...this.current, revision: this.current.revision + 1, files }, operations });
    } catch (error) {
      // Even an unreadable journal may reference these bytes. Preserve all
      // recovery artifacts unless journal absence can be established safely.
      try {
        const journal = await checked(this.binding.root, `${META}/journal.json`);
        if (!await statOrNull(journal)) {
          for (const name of staged) await removeMetadata(this.binding.root, name);
        }
      } catch {
        // A failed safety check or cleanup must not trigger broader deletion.
      }
      throw error;
    }
    return { written: operations.length, unchanged, conflicts };
  }
  async preview(exports: ManagedExport[]): Promise<ReconcilePlan> {
    this.guard();
    const wanted = exportsMap(exports);
    const candidates: ReconcilePlan["candidates"] = [];
    const conflicts: StorageConflict[] = [];
    for (const name of Object.keys(this.current.files).sort()) {
      if (wanted.has(name)) continue;
      const saved = await regular(this.binding.root, name);
      if (!saved || saved.hash !== this.current.files[name]) { conflicts.push({ path: name, reason: saved ? "modified" : "missing" }); continue; }
      candidates.push({ path: name, hash: saved.hash });
    }
    const payload = { version: 1 as const, ...this.binding,
      createdAt: new Date().toISOString(), snapshotDigest: snapshotDigest(wanted), inventoryRevision: this.current.revision,
      candidates, conflicts };
    const stored: StoredPlan = { ...payload, id: digest(encode(payload)).slice(0, 32) };
    await atomic(this.binding.root, `${META}/plans/${stored.id}.json`, encode(stored));
    const { root: _root, accountHash: _account, env: _env, version: _version, ...result } = stored;
    return result;
  }
  async apply(id: string, freshExports: ManagedExport[]): Promise<ApplyResult> {
    this.guard();
    const stored = await this.loadPlan(id);
    if (await regular(this.binding.root, `${META}/applied/${id}.json`)) {
      bound(await readJson(this.binding.root, `${META}/applied/${id}.json`), this.binding);
      return { planId: id, quarantined: 0, alreadyApplied: true };
    }
    const wanted = exportsMap(freshExports);
    if (stored.inventoryRevision !== this.current.revision || stored.snapshotDigest !== snapshotDigest(wanted)) fail("Reconciliation plan is stale; create a new preview.");
    const files = { ...this.current.files };
    const operations: Operation[] = [];
    for (const candidate of stored.candidates) {
      const saved = await regular(this.binding.root, candidate.path);
      if (wanted.has(candidate.path) || files[candidate.path] !== candidate.hash || !saved || saved.hash !== candidate.hash) fail("A reconciliation candidate changed; create a new preview.");
      if (await regular(this.binding.root, `${META}/quarantine/${id}/${candidate.path}`)) fail("Quarantine destination is occupied.");
      operations.push({ kind: "quarantine", ...candidate });
      delete files[candidate.path];
    }
    await this.commit({ version: 1, ...this.binding, id: randomBytes(16).toString("hex"), kind: "apply", planId: id,
      base: this.current, target: { ...this.current, revision: this.current.revision + 1, files }, operations });
    return { planId: id, quarantined: operations.length, alreadyApplied: false };
  }
  async restore(id: string): Promise<RestoreResult> {
    this.guard();
    const stored = await this.loadPlan(id);
    if (!await regular(this.binding.root, `${META}/applied/${id}.json`)) fail("This plan has no applied quarantine to restore.");
    bound(await readJson(this.binding.root, `${META}/applied/${id}.json`), this.binding);
    const files = { ...this.current.files };
    const operations: Operation[] = [];
    const conflicts: StorageConflict[] = [];
    for (const candidate of stored.candidates) {
      const source = await regular(this.binding.root, `${META}/quarantine/${id}/${candidate.path}`);
      if (!source) continue;
      if (source.hash !== candidate.hash) fail("Quarantined content changed; restore refused.");
      if (await regular(this.binding.root, candidate.path) ||
          (files[candidate.path] !== undefined && files[candidate.path] !== candidate.hash)) {
        conflicts.push({ path: candidate.path, reason: "occupied" }); continue;
      }
      operations.push({ kind: "restore", ...candidate });
      files[candidate.path] = candidate.hash;
    }
    if (operations.length) await this.commit({ version: 1, ...this.binding, id: randomBytes(16).toString("hex"), kind: "restore", planId: id,
      base: this.current, target: { ...this.current, revision: this.current.revision + 1, files }, operations });
    return { planId: id, restored: operations.length, conflicts };
  }
}

async function reclaimDeadLock(root: string, lockPath: string): Promise<void> {
  // The stale-lock check and unlink must have a single cooperating owner. An
  // inode recheck alone still leaves a window in which another reclaimer can
  // replace the stale file before this process unlinks its new live lock.
  // Never reclaim this short-lived guard automatically: a crash here requires
  // explicit local inspection, not a timeout that might evict an active writer.
  const guardPath = path.join(root, RECLAIM_LOCK);
  try { await mkdir(guardPath, { mode: 0o700 }); }
  catch (error) {
    if (code(error) === "EEXIST") fail("Sync output lock recovery is in progress or interrupted; inspect it manually.");
    throw error;
  }
  const guard = await lstat(guardPath);
  try {
    const before = await lstat(lockPath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail("Sync output lock is unsafe.");
    const existing = record(await readJson(root, LOCK));
    if (existing["version"] !== 1 || existing["root"] !== root || existing["host"] !== hostname() ||
        !Number.isInteger(existing["pid"]) || (existing["pid"] as number) <= 0 || (existing["pid"] as number) > 2147483647 ||
        !ID.test(String(existing["nonce"]))) fail("Sync output lock is ambiguous; inspect it manually.");
    try { process.kill(existing["pid"] as number, 0); fail("Sync output is locked by a live process."); }
    catch (probe) { if (code(probe) !== "ESRCH") throw probe; }
    const after = await lstat(lockPath);
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) fail("Sync output lock changed; retry later.");
    await unlink(lockPath);
  } finally {
    await rootStillSafe(root);
    const current = await lstat(guardPath);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== guard.ino || current.dev !== guard.dev) {
      fail("Sync output lock recovery guard changed; inspect it manually.");
    }
    await rmdir(guardPath);
    await syncLockDir(root);
  }
}

export async function withSyncOutputLock<T>(outputDir: string, operation: (locked: LockedSyncOutput) => Promise<T>): Promise<T> {
  const root = await resolveRoot(outputDir);
  const lockPath = path.join(root, LOCK);
  let handle: FileHandle | undefined;
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await statOrNull(path.join(root, RECLAIM_LOCK))) {
      fail("Sync output lock recovery is in progress or interrupted; inspect it manually.");
    }
    try { handle = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (code(error) !== "EEXIST") throw error;
      await reclaimDeadLock(root, lockPath);
    }
  }
  if (!handle) fail("Could not acquire the sync output lock.");
  const ownStat = await handle.stat();
  await handle.writeFile(encode({ version: 1, root, host: hostname(), pid: process.pid, nonce }));
  await handle.sync();
  let active = true;
  const guard = () => { if (!active) fail("Sync output lock has already been released."); };
  const openManaged = async (binding: ManagedBinding, create = false): Promise<Storage> => {
    guard(); assertManagedPlatform(); identity(binding);
    const expected = { ...binding, root };
    const metadata = await statOrNull(path.join(root, META));
    if (!metadata && !create) fail("This output has no managed inventory; run --managed first.");
    await directory(path.join(root, META), create);
    let current: Inventory;
    if (!await regular(root, `${META}/inventory.json`)) {
      if (metadata || !create) fail("Managed inventory is missing; refusing to adopt existing files.");
      current = { version: 1, ...expected, revision: 0, files: {} };
      await atomic(root, `${META}/inventory.json`, encode(current));
    } else current = inventory(await readJson(root, `${META}/inventory.json`), expected);
    const storage = new Storage(expected, current, guard);
    await storage.recover();
    return storage;
  };
  try {
    return await operation({
      assertLegacyAllowed: async () => { guard(); if (await statOrNull(path.join(root, META))) fail("Managed output cannot be written by legacy sync."); },
      managed: (binding, options) => openManaged(binding, options?.create ?? false),
      localManaged: async env => {
        guard(); assertManagedPlatform();
        const existing = record(await readJson(root, `${META}/inventory.json`));
        return openManaged({ accountHash: String(existing["accountHash"]), env });
      },
    });
  } finally {
    active = false;
    await handle.close();
    const existing = await statOrNull(lockPath);
    if (!existing || existing.ino !== ownStat.ino || existing.dev !== ownStat.dev) fail("Sync output lock changed before release.");
    const contents = record(await readJson(root, LOCK));
    if (contents["nonce"] !== nonce) fail("Sync output lock ownership changed before release.");
    await unlink(lockPath);
    await syncLockDir(root);
  }
}
