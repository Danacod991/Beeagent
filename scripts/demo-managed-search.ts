/** Synthetic example of searching only active managed conversation exports. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const usage = "Usage: bun scripts/demo-managed-search.ts [--json | --help]";
const args = Bun.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--json" && args[0] !== "--help")) {
  console.error(usage);
  process.exit(2);
}
if (args[0] === "--help") {
  console.log(`${usage}\n\nRuns an isolated synthetic example against the compiled dist/bee CLI.\n--json emits one success report only after all checks and cleanup complete.\nNo Bee account or real recording is used. Run from the source checkout root.`);
  process.exit(0);
}
const json = args[0] === "--json";
function say(message: string) { if (!json) console.log(message); }

const binary = resolve("dist/bee");
if (!await Bun.file(binary).exists()) throw new Error("Run bun run build first.");
async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// Record the actual artifacts present, without borrowing an enclosing checkout's
// Git identity or claiming that a binary hash proves its build provenance.
async function sourceIdentity() {
  async function runtimePaths(directory: string): Promise<string[]> {
    const paths: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) paths.push(...await runtimePaths(path));
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) paths.push(path);
    }
    return paths;
  }
  const paths = [...await runtimePaths("sources"), "bun.lock", "package.json", "tsconfig.json"].sort();
  const files = await Promise.all(paths.map(async (path) => ({ path, sha256: await hashFile(path) })));
  return {
    binary: { path: "dist/bee", sha256: await hashFile(binary) },
    script: { path: "scripts/demo-managed-search.ts", sha256: await hashFile("scripts/demo-managed-search.ts") },
    sourceFiles: files,
    sourceFingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    scope: "Current non-test TypeScript sources, lockfile, package and compiler configuration; SHA-256 per file.",
    buildProvenance: "Binary and current source hashes are independent identities. Build the CLI before running; these hashes alone do not prove that this binary was built from this source.",
  };
}
const identity = await sourceIdentity();
const workspace = await mkdtemp(join(tmpdir(), "bee-managed-search-demo-"));
const config = join(workspace, "config");
const output = join(workspace, "exports");
const question = "Why does Venus show phases through a telescope?";
const sourcePath = "conversations/2023-11-14/201.md";
const editedPath = "conversations/2023-11-14/202.md";
const insightPath = "insights/2023-11-14/401.md";
const localEdit = "An invented local correction to preserve.\n";
const unrelatedNote = `Unrelated invented note: ${question}\n`;
const time = 1_700_000_000_000;
let present = [201, 202];
let unexpectedRequest = false;
let requests = 0;
const stages: Array<{ stage: string; status: "passed"; activeSearchCount: number; activeSearchPaths: string[] }> = [];
let originalHash: string | undefined;
let requestsBeforeRestore: number | undefined;

function conversation(id: number) {
  return {
    id, start_time: time, end_time: time + 1_000, timezone: "UTC",
    device_type: "synthetic", summary: "Invented example, not a personal recording.",
    short_summary: `Invented learning question ${id}`, state: "COMPLETED",
    created_at: time, updated_at: time, suggested_links: [], primary_location: null,
    transcriptions: [{ id: id * 10, realtime: false, utterances: [{
      id: id * 100, realtime: false, start: null, end: null, spoken_at: time,
      text: id === 201 ? question : "Why do clouds change shape?",
      speaker: "Invented speaker", created_at: time,
    }] }],
  };
}

// This tiny consumer rereads only active conversation Markdown on every search.
// It never walks the export root or .bee-managed, and keeps no persistent index.
async function searchActiveQuestions(query: string): Promise<string[]> {
  const matches: string[] = [];
  const conversations = join(output, "conversations");
  for (const day of await readdir(conversations, { withFileTypes: true })) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    for (const file of await readdir(join(conversations, day.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[1-9]\d*\.md$/.test(file.name)) continue;
      const path = `conversations/${day.name}/${file.name}`;
      if ((await readFile(join(output, path), "utf8")).includes(query)) matches.push(path);
    }
  }
  return matches.sort();
}

async function showSearch(stage: string, expected: string[]) {
  const matches = await searchActiveQuestions(question);
  assert.deepEqual(matches, expected, stage);
  stages.push({ stage, status: "passed", activeSearchCount: matches.length, activeSearchPaths: matches });
  say(`${stage}: ${matches.length} active search result(s)${matches.length ? ` — ${matches.join(", ")}` : ""}`);
}

let server: ReturnType<typeof Bun.serve> | undefined;
try {
  say("SYNTHETIC MANAGED-EXPORT SEARCH — no Bee account or real recording used.");
  say(`Invented question: ${question}\n`);
  await mkdir(config, { mode: 0o700 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && !request.headers.has("Authorization")) {
      if (pathname === "/v1/me") return Response.json({ id: 99002, first_name: "Synthetic" });
      if (pathname === "/v1/facts") return Response.json({ facts: [], next_cursor: null });
      if (pathname === "/v1/todos") return Response.json({ todos: [], next_cursor: null });
      if (pathname === "/v1/daily") return Response.json({ daily_summaries: [], next_cursor: null });
      // Matching text outside conversations must not become a conversation result.
      if (pathname === "/v1/insights") return Response.json({ insights: [{
        id: 401, title: "Invented learning insight", description: question,
        suggested_actions: [], generated_at: time, timezone: "UTC", corrections: [],
      }], next_cursor: null });
      if (pathname === "/v1/conversations") return Response.json({ conversations: present.map(conversation), next_cursor: null });
      const match = /^\/v1\/conversations\/(\d+)$/.exec(pathname);
      if (match && present.includes(Number(match[1]))) return Response.json({ conversation: conversation(Number(match[1])) });
    }
    unexpectedRequest = true;
    return Response.json({ error: "Unexpected synthetic fixture request." }, { status: 400 });
  } });
  await writeFile(join(config, "proxy-prod.json"), JSON.stringify({
    address: `http://127.0.0.1:${server.port}`,
  }), { mode: 0o600 });

  async function run(...args: string[]): Promise<Record<string, unknown>> {
    const child = Bun.spawn([binary, "sync", ...args, "--output", output], {
      env: {
        PATH: process.env["PATH"] ?? "", TMPDIR: tmpdir(), HOME: process.env["HOME"],
        BEE_CONFIG_DIR: config, BEE_FORCE_FILE_STORE: "1", BEE_CLI_E2E: "0",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      assert.equal(exit, 0, stderr);
      assert.equal(unexpectedRequest, false);
      const report: unknown = JSON.parse(stdout);
      assert(report !== null && typeof report === "object" && !Array.isArray(report));
      return report as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
      // Stream failure can reject Promise.all before the process exits.
      if (child.exitCode === null) child.kill("SIGKILL");
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            cleanupTimer = setTimeout(() => reject(new Error("Demo child cleanup timed out.")), 2_000);
          }),
        ]);
      } finally { clearTimeout(cleanupTimer); }
    }
  }

  const first = await run("--managed");
  assert.equal(first["written"], 5);
  const originalInsight = await readFile(join(output, insightPath));
  assert(originalInsight.toString("utf8").includes(question));
  const original = await readFile(join(output, sourcePath));
  originalHash = createHash("sha256").update(original).digest("hex");
  await writeFile(join(output, editedPath), localEdit);
  // Matching text in an unrelated note must not become a conversation result.
  await writeFile(join(output, "notes.md"), unrelatedNote, { mode: 0o600 });
  await showSearch("1. Initial managed export", [sourcePath]);

  present = [];
  say("\nFixture change: conversations are now omitted; this does not prove server deletion.");
  await run("--managed");
  await showSearch("2. Managed refresh retains the absent source locally", [sourcePath]);

  const preview = await run("--reconcile");
  const planId = preview["id"];
  assert(typeof planId === "string" && /^[a-f0-9]{32}$/.test(planId));
  assert.deepEqual(preview["candidates"], [{
    path: sourcePath, hash: originalHash,
  }]);
  const conflicts = preview["conflicts"];
  assert(Array.isArray(conflicts) && conflicts.length === 1);
  assert.equal(conflicts[0]?.path, editedPath);
  assert.deepEqual(await readFile(join(output, sourcePath)), original);
  say(`\nPreview candidate: ${sourcePath}`);
  say(`Preserved edited conflict: ${editedPath}`);
  await showSearch("3. Preview leaves active content unchanged", [sourcePath]);
  say("The demo checks the exact candidate/hash, then auto-applies its fixture plan. Real users review first.");

  const applied = await run("--apply", planId);
  assert.equal(applied["quarantined"], 1);
  assert.equal(await Bun.file(join(output, sourcePath)).exists(), false);
  const quarantine = join(output, ".bee-managed", "quarantine", planId, sourcePath);
  assert.deepEqual(await readFile(quarantine), original);
  await showSearch("4. Apply removes the source from fresh active search", []);
  assert.equal(await readFile(join(output, editedPath), "utf8"), localEdit);
  assert.equal(await readFile(join(output, "notes.md"), "utf8"), unrelatedNote);
  assert.deepEqual(await readFile(join(output, insightPath)), originalInsight);
  say("Quarantine still contains the exact source bytes; edited files and unrelated notes survive.");

  await server.stop(true);
  requestsBeforeRestore = requests;
  const restored = await run("--restore", planId);
  assert.equal(requests, requestsBeforeRestore, "Offline restore must not call the stopped fixture service.");
  assert.equal(restored["restored"], 1);
  assert.deepEqual(await readFile(join(output, sourcePath)), original);
  await showSearch("5. Offline restore returns the source to fresh active search", [sourcePath]);
  say("Restoration recovers historical local content; it does not establish current availability in Bee.");
  assert.equal(await readFile(join(output, editedPath), "utf8"), localEdit);
  assert.equal(await readFile(join(output, "notes.md"), "utf8"), unrelatedNote);
  assert.deepEqual(await readFile(join(output, insightPath)), originalInsight);
  // Avoid attaching a passed run to files replaced during the demonstration.
  assert.deepEqual(await sourceIdentity(), identity, "Demo artifacts changed during verification; rebuild and rerun.");
} finally {
  try { await server?.stop(true); }
  finally { await rm(workspace, { recursive: true, force: true }); }
}

// Success is published only after all assertions AND fixture/workspace cleanup.
if (json) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    result: "passed",
    example: "Synthetic active-export search",
    scope: {
      synthetic: true,
      actualBeeAccountUsed: false,
      actualRecordingsUsed: false,
      planAppliedAutomaticallyAfterAssertions: true,
      consumer: "Fresh search of active conversations/YYYY-MM-DD/ID.md files; no persistent index.",
      limitations: [
        "Fixture omission is not proof of remote deletion.",
        "Quarantine retains a private local copy; this is not secure erasure or cache invalidation.",
        "Offline restore does not establish current availability in Bee.",
        "This run does not demonstrate external adoption or real-account compatibility.",
      ],
    },
    stages,
    assertions: {
      preview: { exactCandidatePathAndHash: true, sourcePath, sourceSha256: originalHash, leftSourceUnchanged: true },
      apply: { quarantinedCount: 1, activeSourceAbsent: true, quarantineBytesMatch: true },
      preservation: { editedExportPath: editedPath, editedExportUnchanged: true, unrelatedNoteUnchanged: true,
        insightPath, insightExportUnchanged: true, insightExcludedFromConversationSearch: true },
      offlineRestore: { proxyStopped: true, restoredCount: 1, bytesMatchOriginal: true, fixtureRequestsBefore: requestsBeforeRestore, fixtureRequestsAfter: requests },
      noUnexpectedFixtureRequests: true,
    },
    identity,
    cleanup: { fixtureServerStopped: true, disposableWorkspaceRemoved: true },
  }, null, 2));
} else {
  console.log("\nPASS: all search, preview, quarantine, preservation and byte-exact offline restore assertions.");
  console.log("This demonstrates fresh file search. Retained copies and other indexes require separate handling.");
  console.log("Disposable synthetic workspace removed.");
}
