import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { withSyncOutputLock } from "./storage";
import type { ManagedExport, ManagedStorage, ReconcilePlan } from "./storage";

const directories: string[] = [];
const binding = { accountHash: "a".repeat(64), env: "prod" };
const first = "conversations/2026-01-01/1.md";
const second = "conversations/2026-01-01/2.md";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "bee-managed-storage-")));
  directories.push(directory);
  return directory;
}
async function use<T>(root: string, operation: (storage: ManagedStorage) => Promise<T>, create = false): Promise<T> {
  return withSyncOutputLock(root, async locked => operation(await locked.managed(binding, { create })));
}
async function json(root: string, file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, ".bee-managed", file), "utf8")) as Record<string, unknown>;
}
async function saveJson(root: string, file: string, value: unknown): Promise<void> {
  await writeFile(path.join(root, ".bee-managed", file), JSON.stringify(value), { mode: 0o600 });
}
async function seed(root: string, files: ManagedExport[] = [{ path: first, content: "one" }, { path: second, content: "two" }]): Promise<void> {
  await use(root, storage => storage.sync(files), true);
}
async function pending(root: string, plan: ReconcilePlan, kind: "apply" | "restore"): Promise<void> {
  const base = await json(root, "inventory.json");
  const files = { ...(base["files"] as Record<string, string>) };
  for (const candidate of plan.candidates) {
    if (kind === "apply") delete files[candidate.path];
    else files[candidate.path] = candidate.hash;
  }
  await saveJson(root, "journal.json", {
    version: 1, root, ...binding, id: "b".repeat(32), kind, planId: plan.id, base,
    target: { ...base, revision: (base["revision"] as number) + 1, files },
    operations: plan.candidates.map(candidate => ({ kind: kind === "apply" ? "quarantine" : "restore", ...candidate })),
  });
}

describe("managed sync filesystem", () => {
  it("creates private generated files and updates only unchanged owned exports", async () => {
    const root = await temp();
    expect(await use(root, storage => storage.sync([{ path: "facts.md", content: "first" }]), true)).toEqual({ written: 1, unchanged: 0, conflicts: [] });
    expect(await use(root, storage => storage.sync([{ path: "facts.md", content: "second" }]))).toEqual({ written: 1, unchanged: 0, conflicts: [] });
    expect(await readFile(path.join(root, "facts.md"), "utf8")).toBe("second");
    expect((await lstat(path.join(root, "facts.md"))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.join(root, ".bee-managed"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(root, ".bee-managed/inventory.json"))).mode & 0o777).toBe(0o600);
    expect((await json(root, "inventory.json"))["files"]).toEqual({ "facts.md": sha("second") });
  });

  it("never adopts matching untracked files or overwrites edited owned files", async () => {
    const root = await temp();
    await writeFile(path.join(root, "facts.md"), "same");
    expect((await use(root, storage => storage.sync([{ path: "facts.md", content: "same" }]), true)).conflicts).toEqual([{ path: "facts.md", reason: "untracked" }]);
    expect((await json(root, "inventory.json"))["files"]).toEqual({});
    await seed(root, [{ path: "todos.md", content: "generated" }]);
    await writeFile(path.join(root, "todos.md"), "local edit");
    expect((await use(root, storage => storage.sync([{ path: "todos.md", content: "updated" }]))).conflicts).toEqual([{ path: "todos.md", reason: "modified" }]);
    expect(await readFile(path.join(root, "todos.md"), "utf8")).toBe("local edit");
  });

  it("previews absence candidates, quarantines bytes, and restores offline without overwriting", async () => {
    const root = await temp();
    await seed(root);
    const plan = await use(root, storage => storage.preview([]));
    expect(plan.candidates.map(candidate => candidate.path)).toEqual([first, second]);
    expect(await readFile(path.join(root, first), "utf8")).toBe("one");
    expect((await lstat(path.join(root, `.bee-managed/plans/${plan.id}.json`))).mode & 0o777).toBe(0o600);
    expect(await use(root, storage => storage.apply(plan.id, []))).toEqual({ planId: plan.id, quarantined: 2, alreadyApplied: false });
    expect(await use(root, storage => storage.apply(plan.id, []))).toEqual({ planId: plan.id, quarantined: 0, alreadyApplied: true });
    expect(await readFile(path.join(root, `.bee-managed/quarantine/${plan.id}/${first}`), "utf8")).toBe("one");
    await writeFile(path.join(root, first), "do not replace");
    const restored = await withSyncOutputLock(root, async locked => (await locked.localManaged("prod")).restore(plan.id));
    expect(restored).toEqual({ planId: plan.id, restored: 1, conflicts: [{ path: first, reason: "occupied" }] });
    expect(await readFile(path.join(root, first), "utf8")).toBe("do not replace");
    expect(await readFile(path.join(root, second), "utf8")).toBe("two");
    expect(await readFile(path.join(root, `.bee-managed/quarantine/${plan.id}/${first}`), "utf8")).toBe("one");
  });

  it("keeps edited and locally missing owned files out of removal candidates", async () => {
    const root = await temp();
    await seed(root);
    await writeFile(path.join(root, first), "edited");
    await rm(path.join(root, second));
    const plan = await use(root, storage => storage.preview([]));
    expect(plan.candidates).toEqual([]);
    expect(plan.conflicts).toEqual([{ path: first, reason: "modified" }, { path: second, reason: "missing" }]);
  });

  it("extends a version-one inventory with insights while keeping an earlier plan restorable", async () => {
    const root = await temp();
    await seed(root);
    const earlierPlan = await use(root, storage => storage.preview([{ path: first, content: "one" }]));
    await use(root, storage => storage.apply(earlierPlan.id, [{ path: first, content: "one" }]));
    const insight = "insights/2026-01-02/3.md";
    await use(root, storage => storage.sync([{ path: first, content: "one" }, { path: insight, content: "invented insight" }]));
    expect((await json(root, "inventory.json"))["version"]).toBe(1);
    const restored = await withSyncOutputLock(root, async locked => (await locked.localManaged("prod")).restore(earlierPlan.id));
    expect(restored.restored).toBe(1);
    expect(await readFile(path.join(root, second), "utf8")).toBe("two");
    expect(await readFile(path.join(root, insight), "utf8")).toBe("invented insight");
  });

  it("rejects changed fresh snapshots, changed files, stale inventories and altered plans", async () => {
    const root = await temp();
    await seed(root);
    const plan = await use(root, storage => storage.preview([]));
    await expect(use(root, storage => storage.apply(plan.id, [{ path: first, content: "one" }]))).rejects.toThrow("stale");
    await writeFile(path.join(root, first), "edited");
    await expect(use(root, storage => storage.apply(plan.id, []))).rejects.toThrow("changed");
    await writeFile(path.join(root, first), "one");
    const stored = await json(root, `plans/${plan.id}.json`);
    stored["candidates"] = [];
    await saveJson(root, `plans/${plan.id}.json`, stored);
    await expect(use(root, storage => storage.apply(plan.id, []))).rejects.toThrow("changed after preview");
    const next = await use(root, storage => storage.preview([]));
    await use(root, storage => storage.sync([{ path: "facts.md", content: "new inventory" }]));
    await expect(use(root, storage => storage.apply(next.id, []))).rejects.toThrow("stale");
  });

  it("binds managed state to canonical root, account and environment", async () => {
    const root = await temp();
    await seed(root);
    await expect(withSyncOutputLock(root, locked => locked.managed({ ...binding, accountHash: "c".repeat(64) }))).rejects.toThrow("different root, account, or environment");
    await expect(withSyncOutputLock(root, locked => locked.localManaged("staging"))).rejects.toThrow("different root, account, or environment");
    const copied = await temp();
    await mkdir(path.join(copied, ".bee-managed"));
    await saveJson(copied, "inventory.json", await json(root, "inventory.json"));
    await expect(use(copied, async () => undefined)).rejects.toThrow("different root, account, or environment");
  });

  it("requires explicit creation and refuses legacy writes to managed outputs", async () => {
    const root = await temp();
    await withSyncOutputLock(root, locked => locked.assertLegacyAllowed());
    await expect(use(root, async () => undefined)).rejects.toThrow("run --managed first");
    await seed(root);
    await expect(withSyncOutputLock(root, locked => locked.assertLegacyAllowed())).rejects.toThrow("legacy");
  });

  it("rejects traversal, reserved names, unsupported paths and duplicate exports", async () => {
    const root = await temp();
    for (const name of ["../facts.md", "/facts.md", ".bee-managed/inventory.json", "constructor", "__proto__", "other.md", "daily/../summary.md", "conversations/2026-01-01/0.md", "insights/2026-01-01/0.md", "insights/../1.md", "insights/2026-01-01/1/../../facts.md", "insights/2026-01-01/1.json"]) {
      await expect(use(root, storage => storage.sync([{ path: name, content: "unsafe" }]), true)).rejects.toThrow("export path");
    }
    await expect(use(root, storage => storage.sync([{ path: "facts.md", content: "a" }, { path: "facts.md", content: "b" }]))).rejects.toThrow("duplicate");
  });

  it("rejects symlinked roots, directories, files and external hard links", async () => {
    const root = await temp();
    const external = await temp();
    const alias = path.join(root, "alias");
    await symlink(external, alias);
    await expect(withSyncOutputLock(alias, async () => undefined)).rejects.toThrow("real directory");
    await seed(root, []);
    await symlink(external, path.join(root, "daily"));
    await expect(use(root, storage => storage.sync([{ path: "daily/2026-01-01/summary.md", content: "no" }]))).rejects.toThrow("unsafe directory");
    await writeFile(path.join(external, "original"), "outside");
    await symlink(path.join(external, "original"), path.join(root, "facts.md"));
    await expect(use(root, storage => storage.sync([{ path: "facts.md", content: "no" }]))).rejects.toThrow("regular file");
    await link(path.join(external, "original"), path.join(root, "todos.md"));
    await expect(use(root, storage => storage.sync([{ path: "todos.md", content: "no" }]))).rejects.toThrow("regular file");
    expect(await readFile(path.join(external, "original"), "utf8")).toBe("outside");
  });

  it("preflights late unsafe destinations without leaving staged content on retries", async () => {
    const root = await temp();
    const external = await temp();
    await seed(root, [{ path: "facts.md", content: "owned original" }]);
    await writeFile(path.join(external, "original"), "outside original");
    await symlink(path.join(external, "original"), path.join(root, "todos.md"));
    const before = await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8");
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(use(root, storage => storage.sync([
        { path: first, content: "invented new captured content" },
        { path: "facts.md", content: "invented updated captured content" },
        { path: "todos.md", content: "must not follow the symlink" },
      ]))).rejects.toThrow("regular file");
      expect(await readdir(path.join(root, ".bee-managed/staged"))).toEqual([]);
      expect(await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8")).toBe(before);
      expect(await readFile(path.join(root, "facts.md"), "utf8")).toBe("owned original");
      await expect(lstat(path.join(root, first))).rejects.toHaveProperty("code", "ENOENT");
      await expect(lstat(path.join(root, ".bee-managed/journal.json"))).rejects.toHaveProperty("code", "ENOENT");
      expect(await readFile(path.join(external, "original"), "utf8")).toBe("outside original");
    }
  });

  it("cleans only its own complete and partial stage files when staging fails before a journal", async () => {
    const root = await temp();
    await seed(root, [{ path: "facts.md", content: "owned original" }]);
    const stagedDirectory = path.join(root, ".bee-managed/staged");
    const unknownStage = path.join(stagedDirectory, "retained-review-artifact");
    await writeFile(unknownStage, "unrelated retained content", { mode: 0o600 });
    const before = await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8");
    const originalOpen = fs.open;
    let injected = false;
    const opening = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(stagedDirectory + path.sep) && String(args[0]).endsWith("-1")) {
        const originalWrite = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          injected = true;
          await originalWrite("invented partial content", "utf8");
          throw new Error("injected staging write failure");
        };
      }
      return handle;
    });
    try {
      await expect(use(root, storage => storage.sync([
        { path: first, content: "invented new captured content" },
        { path: "facts.md", content: "invented updated captured content" },
      ]))).rejects.toThrow("injected staging write failure");
    } finally { opening.mockRestore(); }
    expect(injected).toBe(true);
    expect(await readdir(stagedDirectory)).toEqual(["retained-review-artifact"]);
    expect(await readFile(unknownStage, "utf8")).toBe("unrelated retained content");
    expect(await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(root, "facts.md"), "utf8")).toBe("owned original");
    await expect(lstat(path.join(root, first))).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(path.join(root, ".bee-managed/journal.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("preserves staged content when a failed commit leaves an unreadable journal", async () => {
    const root = await temp();
    await seed(root, [{ path: "facts.md", content: "owned original" }]);
    const before = await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8");
    await expect(use(root, async storage => {
      // Inject a journal publication failure after staging, without exposing a
      // production fault hook or depending on filesystem timing.
      const internal = storage as unknown as { commit: () => Promise<void> };
      internal.commit = async () => {
        await writeFile(path.join(root, ".bee-managed/journal.json"), "unreadable journal", { mode: 0o600 });
        throw new Error("injected journal publication failure");
      };
      return storage.sync([{ path: "facts.md", content: "invented replacement content" }]);
    })).rejects.toThrow("injected journal publication failure");
    const staged = await readdir(path.join(root, ".bee-managed/staged"));
    expect(staged).toHaveLength(1);
    expect(await readFile(path.join(root, ".bee-managed/staged", staged[0]!), "utf8")).toBe("invented replacement content");
    expect(await readFile(path.join(root, ".bee-managed/journal.json"), "utf8")).toBe("unreadable journal");
    expect(await readFile(path.join(root, ".bee-managed/inventory.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(root, "facts.md"), "utf8")).toBe("owned original");
  });

  it("does not remove live or ambiguous locks and releases its lock after failures", async () => {
    const root = await temp();
    await withSyncOutputLock(root, async () => {
      await expect(withSyncOutputLock(root, async () => undefined)).rejects.toThrow("live process");
    });
    await expect(withSyncOutputLock(root, async () => { throw new Error("invented failure"); })).rejects.toThrow("invented failure");
    await withSyncOutputLock(root, async () => undefined);
    const lock = path.join(root, ".bee-sync.lock");
    await writeFile(lock, "invalid", { mode: 0o600 });
    await expect(withSyncOutputLock(root, async () => undefined)).rejects.toThrow("metadata");
    expect(await readFile(lock, "utf8")).toBe("invalid");
  });

  it("recovers a dead local lock while retaining foreign-host locks", async () => {
    const root = await temp();
    const process = Bun.spawn([Bun.argv[0]!, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    await process.exited;
    const lock = path.join(root, ".bee-sync.lock");
    const record = { version: 1, root, host: hostname(), pid: process.pid, nonce: "d".repeat(32) };
    await writeFile(lock, JSON.stringify(record), { mode: 0o600 });
    await withSyncOutputLock(root, async () => undefined);
    await writeFile(lock, JSON.stringify({ ...record, host: "another-host" }), { mode: 0o600 });
    await expect(withSyncOutputLock(root, async () => undefined)).rejects.toThrow("ambiguous");
    expect(JSON.parse(await readFile(lock, "utf8")).host).toBe("another-host");
  });

  it("preserves an interrupted reclamation guard instead of guessing that it is stale", async () => {
    const root = await temp();
    const guard = path.join(root, ".bee-sync-reclaim.lock");
    await mkdir(guard, { mode: 0o700 });
    await writeFile(path.join(root, "notes.md"), "Retain unrelated bytes\n");
    await expect(withSyncOutputLock(root, async () => {
      throw new Error("The guarded operation must not run.");
    })).rejects.toThrow("lock recovery is in progress or interrupted");
    expect((await lstat(guard)).isDirectory()).toBe(true);
    await expect(lstat(path.join(root, ".bee-sync.lock"))).rejects.toHaveProperty("code", "ENOENT");
    expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("Retain unrelated bytes\n");
  });

  it("replays interrupted quarantine links and completed moves before committing inventory", async () => {
    const root = await temp();
    await seed(root);
    const plan = await use(root, storage => storage.preview([]));
    await pending(root, plan, "apply");
    for (const [index, candidate] of plan.candidates.entries()) {
      const quarantined = path.join(root, `.bee-managed/quarantine/${plan.id}/${candidate.path}`);
      await mkdir(path.dirname(quarantined), { recursive: true });
      await link(path.join(root, candidate.path), quarantined);
      if (index === 1) await rm(path.join(root, candidate.path));
    }
    await use(root, async () => undefined);
    expect((await json(root, "inventory.json"))["files"]).toEqual({});
    expect(await use(root, storage => storage.restore(plan.id))).toEqual({ planId: plan.id, restored: 2, conflicts: [] });
    expect(await readFile(path.join(root, first), "utf8")).toBe("one");
  });

  it("replays interrupted restore links without overwriting another destination", async () => {
    const root = await temp();
    await seed(root);
    const plan = await use(root, storage => storage.preview([]));
    await use(root, storage => storage.apply(plan.id, []));
    await pending(root, plan, "restore");
    await link(path.join(root, `.bee-managed/quarantine/${plan.id}/${first}`), path.join(root, first));
    await use(root, async () => undefined);
    expect((await json(root, "inventory.json"))["files"]).toEqual({ [first]: sha("one"), [second]: sha("two") });
    expect(await readFile(path.join(root, second), "utf8")).toBe("two");
  });

  it("refuses third-party hard links during journal replay", async () => {
    const root = await temp();
    const external = await temp();
    await seed(root);
    const plan = await use(root, storage => storage.preview([]));
    await pending(root, plan, "apply");
    const quarantined = path.join(root, `.bee-managed/quarantine/${plan.id}/${first}`);
    await mkdir(path.dirname(quarantined), { recursive: true });
    await link(path.join(root, first), quarantined);
    await link(path.join(root, first), path.join(external, "third-link"));
    await expect(use(root, async () => undefined)).rejects.toThrow("preserved");
    expect(await readFile(path.join(root, first), "utf8")).toBe("one");
    expect(await readFile(path.join(external, "third-link"), "utf8")).toBe("one");
  });

  it("recovers a staged update already renamed before inventory commit", async () => {
    const root = await temp();
    await seed(root, [{ path: "facts.md", content: "old" }]);
    const base = await json(root, "inventory.json");
    const id = "e".repeat(32);
    await mkdir(path.join(root, ".bee-managed/staged"), { recursive: true });
    const stage = path.join(root, `.bee-managed/staged/${id}-0`);
    await writeFile(stage, "new", { mode: 0o600 });
    await saveJson(root, "journal.json", { version: 1, root, ...binding, id, kind: "sync", planId: null, base,
      target: { ...base, revision: (base["revision"] as number) + 1, files: { "facts.md": sha("new") } },
      operations: [{ kind: "write", path: "facts.md", hash: sha("new"), previous: sha("old"), stage: `${id}-0` }] });
    await rename(stage, path.join(root, "facts.md"));
    await use(root, async () => undefined);
    expect((await json(root, "inventory.json"))["files"]).toEqual({ "facts.md": sha("new") });
  });

  it("recovers an exclusive new-file link interrupted before staging cleanup", async () => {
    const root = await temp();
    await seed(root, []);
    const base = await json(root, "inventory.json");
    const id = "f".repeat(32);
    await mkdir(path.join(root, ".bee-managed/staged"), { recursive: true });
    const stage = path.join(root, `.bee-managed/staged/${id}-0`);
    await writeFile(stage, "new", { mode: 0o600 });
    await saveJson(root, "journal.json", { version: 1, root, ...binding, id, kind: "sync", planId: null, base,
      target: { ...base, revision: (base["revision"] as number) + 1, files: { "facts.md": sha("new") } },
      operations: [{ kind: "write", path: "facts.md", hash: sha("new"), previous: null, stage: `${id}-0` }] });
    await link(stage, path.join(root, "facts.md"));
    await use(root, async () => undefined);
    expect((await lstat(path.join(root, "facts.md"))).nlink).toBe(1);
    expect((await json(root, "inventory.json"))["files"]).toEqual({ "facts.md": sha("new") });
  });

  it("refuses an externally hardlinked completed update during recovery", async () => {
    const root = await temp();
    const external = await temp();
    await seed(root, [{ path: "facts.md", content: "old" }]);
    const base = await json(root, "inventory.json");
    const id = "f".repeat(32);
    await mkdir(path.join(root, ".bee-managed/staged"), { recursive: true });
    const stage = path.join(root, `.bee-managed/staged/${id}-0`);
    await writeFile(stage, "new", { mode: 0o600 });
    await saveJson(root, "journal.json", { version: 1, root, ...binding, id, kind: "sync", planId: null, base,
      target: { ...base, revision: (base["revision"] as number) + 1, files: { "facts.md": sha("new") } },
      operations: [{ kind: "write", path: "facts.md", hash: sha("new"), previous: sha("old"), stage: `${id}-0` }] });
    await rename(stage, path.join(root, "facts.md"));
    await link(path.join(root, "facts.md"), path.join(external, "linked"));
    await expect(use(root, async () => undefined)).rejects.toThrow("recovery requires local review");
    expect((await json(root, "inventory.json"))["files"]).toEqual({ "facts.md": sha("old") });
    expect(await readFile(path.join(external, "linked"), "utf8")).toBe("new");
  });
});
