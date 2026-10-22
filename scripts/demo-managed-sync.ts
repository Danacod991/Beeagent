/** Invented local-only demonstration. Never reads a personal Bee config/account. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";

const binary = resolve("dist/bee");
if (!await Bun.file(binary).exists()) throw new Error("Run bun run build first.");
const workspace = await mkdtemp(join(tmpdir(), "bee-managed-demo-"));
const config = join(workspace, "config");
const output = join(workspace, "exports");
await mkdir(config, { mode: 0o700 });
let present = [101, 102];
let insightPresent = true;
let changed = false;
let requests = 0;
const time = 1_700_000_000_000;
function conversation(id: number) {
  return { id, start_time: time, end_time: time + 1_000, timezone: "UTC",
    device_type: "synthetic", summary: "Invented demonstration only.", short_summary: `Invented record ${id}`,
    state: "COMPLETED", created_at: time, updated_at: time, transcriptions: [], suggested_links: [], primary_location: null };
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  requests++;
  const pathname = new URL(request.url).pathname;
  assert.equal(request.method, "GET");
  assert.equal(request.headers.has("Authorization"), false);
  if (pathname === "/v1/me") return Response.json({ id: 99001, first_name: "Synthetic" });
  if (pathname === "/v1/facts") return Response.json({ facts: changed ? [{id: 301, text: "Invented new fact", tags: [], created_at: time, confirmed: true}] : [], next_cursor: null });
  if (pathname === "/v1/todos") return Response.json({ todos: [], next_cursor: null });
  if (pathname === "/v1/daily") return Response.json({ daily_summaries: [], next_cursor: null });
  if (pathname === "/v1/insights") return Response.json({ insights: insightPresent ? [{
    id: 401, title: "Invented insight", description: "Invented demonstration only.",
    suggested_actions: ["Try an invented follow-up"], generated_at: time, timezone: "UTC",
    corrections: [{ feedback: "Invented correction" }],
  }] : [], next_cursor: null });
  if (pathname === "/v1/conversations") return Response.json({ conversations: present.map(conversation), next_cursor: null });
  const match = /^\/v1\/conversations\/(\d+)$/.exec(pathname);
  if (match && present.includes(Number(match[1]))) return Response.json({ conversation: conversation(Number(match[1])) });
  throw new Error("Unexpected synthetic demo route.");
} });
await writeFile(join(config, "proxy-prod.json"), JSON.stringify({ address: `http://127.0.0.1:${server.port}` }), { mode: 0o600 });
async function run(args: string[], ok = true) {
  const child = Bun.spawn([binary, "sync", ...args, "--output", output], {
    env: {
      PATH: process.env["PATH"] ?? "", TMPDIR: tmpdir(), HOME: process.env["HOME"],
      BEE_CONFIG_DIR: config, BEE_FORCE_FILE_STORE: "1", BEE_CLI_E2E: "0",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(exit === 0, ok, stderr);
    if (!ok) { assert.match(stderr, /stale|changed/); return null; }
    const report: unknown = JSON.parse(stdout);
    assert(report !== null && typeof report === "object" && !Array.isArray(report));
    return report as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}
function planId(report: Record<string, unknown> | null): string {
  assert(report !== null && report["action"] === "preview");
  const id = report["id"];
  assert(typeof id === "string" && /^[a-f0-9]{32}$/.test(id));
  return id;
}
try {
  console.log("SYNTHETIC LOCAL DEMO — no Bee account or real recording used.");
  const first = await run(["--managed"]);
  assert.equal(first?.["written"], 5);
  const stalePath = join(output, "conversations/2023-11-14/101.md");
  const insightPath = join(output, "insights/2023-11-14/401.md");
  const editedPath = join(output, "conversations/2023-11-14/102.md");
  const original = await readFile(stalePath, "utf8");
  const originalInsight = await readFile(insightPath, "utf8");
  await writeFile(editedPath, "My invented local edit\n");
  await writeFile(join(output, "notes.txt"), "An unrelated invented note\n");
  present = [];
  insightPresent = false;
  const preview = await run(["--reconcile"]);
  const previewId = planId(preview);
  const candidates = preview?.["candidates"];
  assert(Array.isArray(candidates));
  assert.deepEqual(candidates.map((candidate: unknown) => {
    assert(candidate !== null && typeof candidate === "object" && "path" in candidate);
    return candidate.path;
  }), [
    "conversations/2023-11-14/101.md", "insights/2023-11-14/401.md",
  ]);
  const conflicts = preview?.["conflicts"];
  assert(Array.isArray(conflicts) && conflicts.length === 1);
  assert.equal(await readFile(stalePath, "utf8"), original);
  assert.equal(await readFile(insightPath, "utf8"), originalInsight);
  console.log("PASS: preview retained exports; conversation and insight candidates, one edited conflict.");
  changed = true;
  await run(["--apply", previewId], false);
  assert.equal(await readFile(stalePath, "utf8"), original);
  assert.equal(await readFile(insightPath, "utf8"), originalInsight);
  console.log("PASS: a remote change invalidated the reviewed plan without moving files.");
  const fresh = await run(["--reconcile"]);
  const freshId = planId(fresh);
  const applied = await run(["--apply", freshId]);
  assert.equal(applied?.["quarantined"], 2);
  assert.equal(await Bun.file(stalePath).exists(), false);
  assert.equal(await Bun.file(insightPath).exists(), false);
  assert.equal(await readFile(join(output, ".bee-managed", "quarantine", freshId, "conversations/2023-11-14/101.md"), "utf8"), original);
  assert.equal(await readFile(join(output, ".bee-managed", "quarantine", freshId, "insights/2023-11-14/401.md"), "utf8"), originalInsight);
  assert.equal(await readFile(editedPath, "utf8"), "My invented local edit\n");
  console.log("PASS: apply quarantined only the unchanged conversation and insight candidates.");
  server.stop(true);
  const beforeRestore = requests;
  const restored = await run(["--restore", freshId]);
  assert.equal(restored?.["restored"], 2);
  assert.equal(requests, beforeRestore);
  assert.equal(await readFile(stalePath, "utf8"), original);
  assert.equal(await readFile(insightPath, "utf8"), originalInsight);
  assert.equal(await readFile(join(output, "notes.txt"), "utf8"), "An unrelated invented note\n");
  console.log("PASS: offline restore recovered exact bytes; local edits and unrelated notes survived.");
  console.log("Demo complete; disposable synthetic workspace removed.");
} finally {
  server.stop(true);
  await rm(workspace, { recursive: true, force: true });
}
