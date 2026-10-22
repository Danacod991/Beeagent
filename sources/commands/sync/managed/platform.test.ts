import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// This is a simulated platform boundary in a separate process, not evidence of
// an actual Windows run. Real local file operations still execute, except that
// opening a directory for fsync is rejected as it would be on Windows.
const childSource = `
import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { hostname } from "node:os";
const actual = { ...fs };
const [base, mode] = process.argv.slice(2);
let directoryFlushAttempts = 0;
mock.module("node:fs/promises", () => ({
  ...actual,
  open: async (file, flags, ...args) => {
    if (flags === "r" && (await actual.lstat(file)).isDirectory()) {
      directoryFlushAttempts++;
      throw Object.assign(new Error("Simulated unsupported Windows directory fsync"), { code: "EPERM" });
    }
    return actual.open(file, flags, ...args);
  },
}));
const { syncCommand } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "../index.ts")).href)});
const { withSyncOutputLock } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "storage.ts")).href)});
const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
await dead.exited;
Object.defineProperty(process, "platform", { value: "win32" });
let requests = 0;
const context = {
  env: "prod",
  client: {
    env: "prod", baseUrl: "http://fixture.invalid", isProxy: true,
    fetch: async request => {
      requests++;
      const pathname = new URL(request, "http://fixture.invalid").pathname;
      if (pathname === "/v1/me") return Response.json({ id: 90001 });
      if (pathname === "/v1/facts") return Response.json({ facts: [{
        id: 1, text: "Invented platform fixture", tags: [], created_at: 1700000000000, confirmed: true,
      }], next_cursor: null });
      throw new Error("Unexpected synthetic API request: " + pathname);
    },
  },
};
const root = path.join(base, "exports");
if (mode === "legacy" || mode === "stale") {
  await actual.mkdir(root);
  if (mode === "stale") await actual.writeFile(path.join(root, ".bee-sync.lock"), JSON.stringify({
    version: 1, root, host: hostname(), pid: dead.pid, nonce: "a".repeat(32),
  }));
  await syncCommand.run(["--output", root, "--only", "facts", "--full"], context);
  assert.match(await actual.readFile(path.join(root, "facts.md"), "utf8"), /Invented platform fixture/);
  assert.ok(requests > 0);
  await assert.rejects(actual.lstat(path.join(root, ".bee-sync.lock")), { code: "ENOENT" });
  await assert.rejects(actual.lstat(path.join(root, ".bee-sync-reclaim.lock")), { code: "ENOENT" });
} else {
  for (const args of [["--managed"], ["--reconcile"], ["--apply", "b".repeat(32)], ["--restore", "b".repeat(32)]]) {
    await assert.rejects(syncCommand.run([...args, "--output", root], context), /not supported on Windows/);
    await assert.rejects(actual.lstat(root), { code: "ENOENT" });
  }
  assert.equal(requests, 0);
  await withSyncOutputLock(root, async locked => {
    await assert.rejects(locked.managed({ accountHash: "c".repeat(64), env: "prod" }, { create: true }), /not supported on Windows/);
    await assert.rejects(locked.localManaged("prod"), /not supported on Windows/);
  });
  await assert.rejects(actual.lstat(path.join(root, ".bee-managed")), { code: "ENOENT" });
  await assert.rejects(actual.lstat(path.join(root, ".bee-sync.lock")), { code: "ENOENT" });
}
assert.equal(directoryFlushAttempts, 0);
console.log("PASS simulated Windows boundary: " + mode);
`;

async function run(mode: "legacy" | "stale" | "managed") {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "bee-platform-boundary-")));
  directories.push(base);
  const script = path.join(base, "platform-child.ts");
  await writeFile(script, childSource, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, script, base, mode], {
    cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", TMPDIR: tmpdir(), BEE_CLI_E2E: "0" },
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain(`PASS simulated Windows boundary: ${mode}`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("managed sync simulated Windows boundary", () => {
  it("preserves ordinary sync without requiring directory fsync", () => run("legacy"));
  it("reclaims an ordinary dead lock without requiring directory fsync", () => run("stale"));
  it("refuses managed actions before API requests or managed state creation", () => run("managed"));
});
