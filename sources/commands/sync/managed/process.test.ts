import { afterEach, describe, expect, it } from "bun:test";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withSyncOutputLock } from "./storage";

const directories: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const binding = { accountHash: "e".repeat(64), env: "prod" };
const first = "conversations/2026-01-01/1.md";
const second = "conversations/2026-01-01/2.md";
const originalFirst = "Invented first export.\nPreserve these bytes: é 🌙\n";
const originalSecond = "Invented second export.\r\nPreserve line endings.\r\n";
const unrelated = "Untracked local notes must remain untouched.\n";

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// The filesystem itself and production storage implementation are real. Only
// the child process substitutes link/unlink with wrappers that exit immediately
// AFTER the selected real operation succeeds. This is deterministic process
// fault injection, not simulation of physical power loss or a production hook.
const childSource = `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
const actual = { ...fs };
const [root, planId, phase] = process.argv.slice(2);
const first = path.join(root, ${JSON.stringify(first)});
function crashAfter(operation, source) {
  if (phase === operation && String(source) === first) process.exit(73);
}
mock.module("node:fs/promises", () => ({
  ...actual,
  link: async (source, destination) => {
    await actual.link(source, destination);
    crashAfter("link", source);
  },
  unlink: async (source) => {
    await actual.unlink(source);
    crashAfter("unlink", source);
  },
}));
const { withSyncOutputLock } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "storage.ts")).href)});
await withSyncOutputLock(root, async (locked) => {
  const storage = await locked.managed(${JSON.stringify(binding)});
  await storage.apply(planId, []);
});
process.exit(74); // A missing fault boundary is a test failure, never success.
`;

// Pause one real stale-lock unlink after all identity checks. Before the guard
// was added, another writer could reclaim the stale lock in this window and
// have its new live lock removed by the delayed unlink. The fault wrapper only
// widens that real race; neither process bypasses production locking.
const reclaimChildSource = `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
const actual = { ...fs };
const [base, root, role] = process.argv.slice(2);
async function waitFor(name) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try { await actual.access(path.join(base, name)); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic child coordination timed out.");
}
let paused = false;
if (role === "first") mock.module("node:fs/promises", () => ({
  ...actual,
  unlink: async file => {
    if (!paused && file === path.join(root, ".bee-sync.lock")) {
      paused = true;
      await actual.writeFile(path.join(base, "before-unlink"), "");
      await waitFor("resume-first");
    }
    return actual.unlink(file);
  },
}));
const { withSyncOutputLock } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "storage.ts")).href)});
try {
  await withSyncOutputLock(root, async () => {
    await actual.writeFile(path.join(base, role + "-entered"), "");
    await waitFor("release-" + role);
  });
} catch (error) {
  await actual.writeFile(path.join(base, role + "-refused"), error.message);
}
`;

async function waitForAny(files: string[]): Promise<string> {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    for (const file of files) {
      try { await access(file); return file; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Synthetic parent coordination timed out.");
}

describe("managed reconciliation process crash recovery", () => {
  it("serializes stale-lock reclamation before a delayed unlink can remove a new live lock", async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "bee-managed-reclaim-")));
    directories.push(base);
    const root = path.join(base, "exports");
    await mkdir(root);
    await writeFile(path.join(root, "notes.md"), unrelated, { mode: 0o600 });
    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    children.push(dead);
    await dead.exited;
    await writeFile(path.join(root, ".bee-sync.lock"), JSON.stringify({
      version: 1, root, host: hostname(), pid: dead.pid, nonce: "a".repeat(32),
    }), { mode: 0o600 });
    const script = path.join(base, "reclaim-child.ts");
    await writeFile(script, reclaimChildSource, { mode: 0o600 });
    const launch = (role: string) => {
      const child = Bun.spawn([process.execPath, script, base, root, role], {
        cwd: process.cwd(), stdout: "ignore", stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", TMPDIR: tmpdir() },
      });
      children.push(child);
      return child;
    };
    const firstChild = launch("first");
    await waitForAny([path.join(base, "before-unlink")]);
    const secondChild = launch("second");
    const refused = path.join(base, "second-refused");
    expect(await waitForAny([refused, path.join(base, "second-entered")])).toBe(refused);
    expect(await readFile(refused, "utf8")).toContain("lock recovery is in progress or interrupted");
    expect(await secondChild.exited).toBe(0);
    expect(await new Response(secondChild.stderr).text()).toBe("");
    await writeFile(path.join(base, "resume-first"), "");
    await waitForAny([path.join(base, "first-entered")]);
    const heldLock = JSON.parse(await readFile(path.join(root, ".bee-sync.lock"), "utf8")) as { pid: number };
    expect(heldLock.pid).toBe(firstChild.pid);
    await expect(withSyncOutputLock(root, async () => undefined)).rejects.toThrow("live process");
    await writeFile(path.join(base, "release-first"), "");
    expect(await firstChild.exited).toBe(0);
    expect(await new Response(firstChild.stderr).text()).toBe("");
    await expect(lstat(path.join(base, "first-refused"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(path.join(root, ".bee-sync.lock"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(lstat(path.join(root, ".bee-sync-reclaim.lock"))).rejects.toHaveProperty("code", "ENOENT");
    await withSyncOutputLock(root, async () => undefined);
    expect(await readFile(path.join(root, "notes.md"))).toEqual(Buffer.from(unrelated));
  }, 10_000);

  for (const phase of ["link", "unlink"] as const) {
    it(`recovers a child terminated after the first quarantine ${phase} and restores offline`, async () => {
      const base = await realpath(await mkdtemp(path.join(tmpdir(), "bee-managed-process-")));
      directories.push(base);
      const root = path.join(base, "exports");
      await mkdir(root);
      await withSyncOutputLock(root, async (locked) => {
        const storage = await locked.managed(binding, { create: true });
        expect((await storage.sync([
          { path: first, content: originalFirst },
          { path: second, content: originalSecond },
        ])).written).toBe(2);
      });
      await writeFile(path.join(root, "notes.md"), unrelated, { mode: 0o600 });
      const plan = await withSyncOutputLock(root, async (locked) => (await locked.managed(binding)).preview([]));
      expect(plan.candidates.map((candidate) => candidate.path)).toEqual([first, second]);

      const script = path.join(base, "crash-child.ts");
      await writeFile(script, childSource, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, script, root, plan.id, phase], {
        cwd: process.cwd(), stdout: "ignore", stderr: "pipe",
        // This child needs no account credentials, home directory or network.
        env: { PATH: process.env["PATH"] ?? "", TMPDIR: tmpdir() },
      });
      children.push(child);
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      let status: number;
      try { status = await child.exited; }
      finally { clearTimeout(timer); }
      expect(await new Response(child.stderr).text()).toBe("");
      expect(status).toBe(73);

      const metadata = path.join(root, ".bee-managed");
      const journalPath = path.join(metadata, "journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { kind: string; planId: string };
      expect(journal.kind).toBe("apply");
      expect(journal.planId).toBe(plan.id);
      expect((await lstat(path.join(root, ".bee-sync.lock"))).isFile()).toBe(true);
      const firstQuarantine = path.join(metadata, "quarantine", plan.id, first);
      expect(await readFile(firstQuarantine)).toEqual(Buffer.from(originalFirst));
      if (phase === "link") {
        const source = await lstat(path.join(root, first));
        const copy = await lstat(firstQuarantine);
        expect(source.ino).toBe(copy.ino);
        expect(source.nlink).toBe(2);
      } else {
        await expect(lstat(path.join(root, first))).rejects.toHaveProperty("code", "ENOENT");
      }
      // The second operation has not run, proving interruption was mid-plan.
      expect(await readFile(path.join(root, second))).toEqual(Buffer.from(originalSecond));
      await expect(lstat(path.join(metadata, "quarantine", plan.id, second))).rejects.toHaveProperty("code", "ENOENT");
      expect(await readFile(path.join(root, "notes.md"))).toEqual(Buffer.from(unrelated));

      // No CommandContext, Bee client or authentication is involved in recovery.
      // Reopening reclaims the dead process's lock and rolls the journal forward.
      await withSyncOutputLock(root, async (locked) => {
        const storage = await locked.localManaged("prod");
        await expect(lstat(journalPath)).rejects.toHaveProperty("code", "ENOENT");
        expect(await readFile(firstQuarantine)).toEqual(Buffer.from(originalFirst));
        expect(await readFile(path.join(metadata, "quarantine", plan.id, second))).toEqual(Buffer.from(originalSecond));
        expect(await storage.restore(plan.id)).toEqual({ planId: plan.id, restored: 2, conflicts: [] });
      });
      expect(await readFile(path.join(root, first))).toEqual(Buffer.from(originalFirst));
      expect(await readFile(path.join(root, second))).toEqual(Buffer.from(originalSecond));
      expect(await readFile(path.join(root, "notes.md"))).toEqual(Buffer.from(unrelated));
      expect((await lstat(path.join(root, first))).nlink).toBe(1);
      expect((await lstat(path.join(root, second))).nlink).toBe(1);
      await expect(lstat(journalPath)).rejects.toHaveProperty("code", "ENOENT");
      await expect(lstat(path.join(root, ".bee-sync.lock"))).rejects.toHaveProperty("code", "ENOENT");
      await withSyncOutputLock(root, async (locked) => {
        expect(await (await locked.localManaged("prod")).restore(plan.id)).toEqual({ planId: plan.id, restored: 0, conflicts: [] });
      });
    }, 10_000);
  }
});
