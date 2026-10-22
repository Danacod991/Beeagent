import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../../../scripts/demo-managed-search.ts");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// No compiled binary is needed: these calls must return before source inspection,
// fixture setup or CLI execution. An empty cwd also prevents borrowing a build.
async function invoke(...args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "bee-demo-arguments-"));
  directories.push(directory);
  // Preserve the runtime's normal HOME; only CLI configuration, cwd and temp
  // state belong to this disposable argument-boundary check.
  const work = join(directory, "work");
  const scratch = join(directory, "tmp");
  const config = join(directory, "config");
  await Promise.all([work, scratch, config].map((path) => mkdir(path)));
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: work,
    env: { TMPDIR: scratch, HOME: process.env["HOME"], BEE_CONFIG_DIR: config, BEE_FORCE_FILE_STORE: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    for (const path of [work, scratch, config]) expect(await readdir(path)).toEqual([]);
    return { stdout, stderr, exit };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

describe("synthetic reference demo argument boundary", () => {
  it("shows help without a build, checkout, fixture or temporary state", async () => {
    const result = await invoke("--help");
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("No Bee account or real recording is used.");
  });

  for (const args of [["--unknown"], ["--output", "ignored"], ["--json", "--json"], ["--json", "--help"]]) {
    it(`rejects ${args.join(" ")} without starting or emitting a success report`, async () => {
      const result = await invoke(...args);
      expect(result.exit).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("Usage:");
      expect(result.stderr).not.toContain("Run bun run build first.");
    });
  }

  it("emits no JSON success report when the compiled CLI is unavailable", async () => {
    const result = await invoke("--json");
    expect(result.exit).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Run bun run build first.");
  });
});
