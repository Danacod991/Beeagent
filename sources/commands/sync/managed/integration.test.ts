import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "@/commands/types";
import { syncCommand } from "@/commands/sync";

const temporaryDirectories: string[] = [];
const TIME = 1_700_000_000_000;
const DAY = "2023-11-14";
const conversationPath = (id: number) => `conversations/${DAY}/${id}.md`;
const insightPath = (id: number, day = DAY) => `insights/${day}/${id}.md`;
type Report = Record<string, unknown>;
type Fixture = ReturnType<typeof fixtureContext>;

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  process.exitCode = 0;
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bee-managed-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

function conversation(id: number, summary = `Invented conversation ${id}`) {
  return {
    id, start_time: TIME, end_time: TIME + 60_000, timezone: "UTC",
    device_type: "fixture", summary: null, short_summary: summary,
    state: "COMPLETED", created_at: TIME, updated_at: TIME,
    transcriptions: [{
      id: id * 10, realtime: false, utterances: [{
        id: id * 100, realtime: false, start: null, end: null,
        spoken_at: TIME, text: "Invented transcript kept out of command reports.",
        speaker: "Fixture speaker", created_at: TIME,
      }],
    }],
    suggested_links: [], primary_location: null,
  };
}

function insight(id: number, title: string | null = `Invented insight ${id}`) {
  return {
    id, title, description: "Invented insight description" as string | null,
    suggested_actions: ["Try an invented action"], generated_at: TIME, timezone: "UTC",
    corrections: [{ feedback: "Invented correction" }],
  };
}

/** No HTTP listener, credentials, auth storage or real Bee client is involved. */
function fixtureContext() {
  const state = {
    accountId: 1001,
    offline: false,
    factText: "Invented fact kept out of command reports.",
    insightsUnavailable: false,
    insights: new Map<number, ReturnType<typeof insight>>(),
    conversations: new Map([
      [101, conversation(101)], [102, conversation(102)],
    ]),
  };
  const requests: { method: string; pathname: string; search: string }[] = [];
  const fact = () => ({
    id: 1, text: state.factText, tags: ["fixture"], created_at: TIME, confirmed: true,
  });
  const todo = {
    id: 2, text: "Invented task", alarm_at: null, completed: false, created_at: TIME,
  };
  const daily = {
    id: 10, date: DAY, date_time: TIME, timezone: "UTC", short_summary: "Invented day",
    summary: null, email_summary: null, calendar_summary: null,
    conversations_count: 0, locations: null, created_at: TIME, conversations: [],
  };
  const context: CommandContext = {
    env: "prod",
    client: {
      env: "prod", baseUrl: "http://fixture.invalid", isProxy: true,
      fetch: async (requestPath, init) => {
        const url = new URL(requestPath, "http://fixture.invalid");
        requests.push({ method: init?.method ?? "GET", pathname: url.pathname, search: url.search });
        if (state.offline) throw new Error("The fixture is intentionally offline.");
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        switch (url.pathname) {
          case "/v1/me": return Response.json({ id: state.accountId });
          case "/v1/changes": return Response.json({
            dailies: [], conversations: [], facts: [], todos: [], journals: [], insights: [],
            since: 0, until: TIME, updated: true, next_cursor: null,
          });
          case "/v1/facts": return Response.json({ facts: [fact()], next_cursor: null });
          case "/v1/facts/1": return Response.json(fact());
          case "/v1/todos": return Response.json({ todos: [todo], next_cursor: null });
          case "/v1/todos/2": return Response.json(todo);
          case "/v1/daily": return Response.json({ daily_summaries: [daily], next_cursor: null });
          case "/v1/daily/10": return Response.json({ daily_summary: daily });
          case "/v1/insights": return state.insightsUnavailable
            ? Response.json({ error: "Invented unavailable endpoint" }, { status: 404 })
            : Response.json({ insights: [...state.insights.values()], next_cursor: null });
          case "/v1/conversations": return Response.json({
            conversations: [...state.conversations.values()], next_cursor: null,
          });
          case "/v1/conversations/batch": {
            const body = JSON.parse(String(init?.body)) as { ids: number[] };
            return Response.json({ conversations: body.ids.map((id) => state.conversations.get(id)) });
          }
          default: {
            const id = Number(url.pathname.match(/^\/v1\/conversations\/(\d+)$/)?.[1]);
            if (state.conversations.has(id)) {
              return Response.json({ conversation: state.conversations.get(id) });
            }
            throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
          }
        }
      },
    },
  };
  return { state, requests, context };
}

// These tests are explicitly serial because console capture is process-global.
// Each command restores its spies before any next command or test can run.
async function command(fixture: Fixture, args: string[]): Promise<Report | null> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values) => {
    lines.push(values.join(" "));
  });
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    await syncCommand.run(args, fixture.context);
  } finally {
    log.mockRestore();
    diagnostic.mockRestore();
  }
  expect(lines.join("\n")).not.toContain("Invented transcript");
  expect(lines.join("\n")).not.toContain(fixture.state.factText);
  if (lines.length === 0) return null;
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Report;
}

async function managed(fixture: Fixture, directory: string, ...args: string[]): Promise<Report> {
  const report = await command(fixture, [...args, "--output", directory]);
  expect(report).not.toBeNull();
  return report!;
}

function planId(report: Report): string {
  expect(report["action"]).toBe("preview");
  expect(typeof report["id"]).toBe("string");
  return report["id"] as string;
}

function candidatePaths(report: Report): string[] {
  return (report["candidates"] as { path: string }[]).map((candidate) => candidate.path);
}

async function exportedFiles(directory: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await exportedFiles(directory, name));
    else files[name] = readFileSync(path.join(directory, name), "utf8");
  }
  return files;
}

describe.serial("managed sync command integration", () => {
  it("updates owned files, previews and applies quarantine, then restores without a request", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    const first = await managed(fixture, directory, "--managed");
    expect(first["action"]).toBe("sync");
    expect(first["written"]).toBe(5);
    expect(existsSync(path.join(directory, ".bee-managed", "inventory.json"))).toBe(true);

    const edited = conversationPath(102);
    writeFileSync(path.join(directory, edited), "My local edit\n");
    writeFileSync(path.join(directory, "notes.md"), "My unrelated note\n");
    fixture.state.conversations.set(101, conversation(101, "Invented updated summary"));
    fixture.state.conversations.set(103, conversation(103));
    const updated = await managed(fixture, directory, "--managed");
    expect(updated["written"]).toBe(2);
    expect(updated["conflicts"]).toEqual([{ path: edited, reason: "modified" }]);
    expect(readFileSync(path.join(directory, conversationPath(101)), "utf8")).toContain("Invented updated summary");
    expect(existsSync(path.join(directory, conversationPath(103)))).toBe(true);

    fixture.state.conversations.delete(101);
    const beforePreview = await exportedFiles(directory);
    const preview = await managed(fixture, directory, "--reconcile");
    const id = planId(preview);
    expect(candidatePaths(preview)).toEqual([conversationPath(101)]);
    expect(await exportedFiles(directory)).toEqual(beforePreview);
    const applied = await managed(fixture, directory, "--apply", id);
    expect(applied).toMatchObject({ action: "apply", planId: id, quarantined: 1, alreadyApplied: false });
    expect(existsSync(path.join(directory, conversationPath(101)))).toBe(false);
    expect(readFileSync(path.join(directory, ".bee-managed", "quarantine", id, conversationPath(101)), "utf8"))
      .toBe(beforePreview[conversationPath(101)]!);

    fixture.state.offline = true;
    fixture.requests.length = 0;
    const restored = await managed(fixture, directory, "--restore", id);
    expect(restored).toMatchObject({ action: "restore", planId: id, restored: 1, conflicts: [] });
    expect(fixture.requests).toEqual([]);
    expect(await exportedFiles(directory)).toEqual(beforePreview);
    expect(readFileSync(path.join(directory, edited), "utf8")).toBe("My local edit\n");
    expect(readFileSync(path.join(directory, "notes.md"), "utf8")).toBe("My unrelated note\n");
  });

  it("preserves edited and untracked obsolete paths instead of adopting or quarantining them", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    const edited = conversationPath(102);
    const untracked = conversationPath(999);
    writeFileSync(path.join(directory, edited), "Preserve this changed export\n");
    writeFileSync(path.join(directory, untracked), "Preserve this unmanaged file\n");
    fixture.state.conversations.clear();
    const preview = await managed(fixture, directory, "--reconcile");
    expect(candidatePaths(preview)).toEqual([conversationPath(101)]);
    expect(preview["conflicts"]).toContainEqual({ path: edited, reason: "modified" });
    await managed(fixture, directory, "--apply", planId(preview));
    expect(readFileSync(path.join(directory, edited), "utf8")).toBe("Preserve this changed export\n");
    expect(readFileSync(path.join(directory, untracked), "utf8")).toBe("Preserve this unmanaged file\n");
  });

  it("preserves an existing destination without adopting it into managed ownership", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    writeFileSync(path.join(directory, "facts.md"), "My existing facts notes\n");
    const first = await managed(fixture, directory, "--managed");
    expect(first["written"]).toBe(4);
    expect(first["conflicts"]).toContainEqual({ path: "facts.md", reason: "untracked" });
    fixture.state.factText = "Invented remote fact update";
    const second = await managed(fixture, directory, "--managed");
    expect(second["conflicts"]).toContainEqual({ path: "facts.md", reason: "untracked" });
    expect(readFileSync(path.join(directory, "facts.md"), "utf8")).toBe("My existing facts notes\n");
    const inventory = JSON.parse(readFileSync(path.join(directory, ".bee-managed", "inventory.json"), "utf8")) as {
      files: Record<string, string>;
    };
    expect(Object.hasOwn(inventory.files, "facts.md")).toBe(false);
  });

  it("refuses legacy sync in a managed output directory before any API request", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    const before = await exportedFiles(directory);
    fixture.requests.length = 0;
    await expect(command(fixture, ["--full", "--output", directory])).rejects.toThrow(/managed/i);
    expect(fixture.requests).toEqual([]);
    expect(await exportedFiles(directory)).toEqual(before);
  });

  it("rejects filtered, unknown and ambiguous managed arguments before any request", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    const id = "0123456789abcdef0123456789abcdef";
    for (const args of [
      ["--managed", "--recent-days", "2"], ["--managed", "--since", "1"],
      ["--reconcile", "--only", "facts"], ["--apply", id, "--full"],
      ["--restore", id, "--unknown"], ["--managed", "--reconcile"],
      ["--managed", "--output", "one", "--output", "two"],
    ]) {
      await expect(command(fixture, [...args, "--output", directory])).rejects.toThrow();
      expect(fixture.requests).toEqual([]);
    }
    expect(existsSync(path.join(directory, ".bee-managed"))).toBe(false);
  });

  it("invalidates a plan when a different remote file changes after preview", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.conversations.delete(101);
    const preview = await managed(fixture, directory, "--reconcile");
    fixture.state.factText = "Invented changed fact after preview";
    const before = await exportedFiles(directory);
    await expect(managed(fixture, directory, "--apply", planId(preview))).rejects.toThrow(/changed|stale|snapshot/i);
    expect(await exportedFiles(directory)).toEqual(before);
  });

  it("does not quarantine a candidate that reappears remotely before apply", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    const original = fixture.state.conversations.get(101)!;
    fixture.state.conversations.delete(101);
    const preview = await managed(fixture, directory, "--reconcile");
    expect(candidatePaths(preview)).toEqual([conversationPath(101)]);
    fixture.state.conversations.set(101, original);
    await expect(managed(fixture, directory, "--apply", planId(preview))).rejects.toThrow(/changed|stale|snapshot/i);
    expect(existsSync(path.join(directory, conversationPath(101)))).toBe(true);
  });

  it("rejects an edited candidate after preview before moving any earlier candidate", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.conversations.clear();
    const preview = await managed(fixture, directory, "--reconcile");
    expect(candidatePaths(preview)).toEqual([conversationPath(101), conversationPath(102)]);
    writeFileSync(path.join(directory, conversationPath(102)), "Edit made after preview\n");
    const before = await exportedFiles(directory);
    const inventoryBefore = readFileSync(path.join(directory, ".bee-managed", "inventory.json"), "utf8");
    await expect(managed(fixture, directory, "--apply", planId(preview))).rejects.toThrow(/changed|candidate/i);
    expect(await exportedFiles(directory)).toEqual(before);
    expect(readFileSync(path.join(directory, ".bee-managed", "inventory.json"), "utf8")).toBe(inventoryBefore);
    expect(existsSync(path.join(directory, ".bee-managed", "quarantine", planId(preview)))).toBe(false);
  });

  it("refuses a second account behind the same proxy without changing exports", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.conversations.delete(101);
    const preview = await managed(fixture, directory, "--reconcile");
    const before = await exportedFiles(directory);
    fixture.state.accountId = 2002;
    await expect(managed(fixture, directory, "--apply", planId(preview))).rejects.toThrow(/account|environment|root/i);
    expect(await exportedFiles(directory)).toEqual(before);
  });

  it("does not overwrite a new file occupying a restore destination", async () => {
    const fixture = fixtureContext();
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.conversations.delete(101);
    const preview = await managed(fixture, directory, "--reconcile");
    const id = planId(preview);
    await managed(fixture, directory, "--apply", id);
    writeFileSync(path.join(directory, conversationPath(101)), "New local destination\n");
    fixture.state.offline = true;
    fixture.requests.length = 0;
    const restored = await managed(fixture, directory, "--restore", id);
    expect(restored["restored"]).toBe(0);
    expect(restored["conflicts"]).toContainEqual({ path: conversationPath(101), reason: "occupied" });
    expect(fixture.requests).toEqual([]);
    expect(readFileSync(path.join(directory, conversationPath(101)), "utf8")).toBe("New local destination\n");
    expect(existsSync(path.join(directory, ".bee-managed", "quarantine", id, conversationPath(101)))).toBe(true);
  });

  it("quarantines an absent insight and restores exact bytes offline while preserving edits and unknown files", async () => {
    const fixture = fixtureContext();
    fixture.state.insights.set(301, { ...insight(301), timezone: "Asia/Dhaka" });
    fixture.state.insights.set(302, insight(302));
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    const absent = insightPath(301, "2023-11-15");
    const edited = insightPath(302);
    const unknown = insightPath(399);
    const original = readFileSync(path.join(directory, absent));
    writeFileSync(path.join(directory, edited), "Preserve my insight correction\n");
    writeFileSync(path.join(directory, unknown), "Preserve my unmanaged insight\n");
    fixture.state.insights.clear();
    const before = await exportedFiles(directory);
    const preview = await managed(fixture, directory, "--reconcile");
    expect(candidatePaths(preview)).toEqual([absent]);
    expect(preview["conflicts"]).toContainEqual({ path: edited, reason: "modified" });
    expect(await exportedFiles(directory)).toEqual(before);
    const id = planId(preview);
    const applied = await managed(fixture, directory, "--apply", id);
    expect(applied["quarantined"]).toBe(1);
    expect(existsSync(path.join(directory, absent))).toBe(false);
    expect(readFileSync(path.join(directory, ".bee-managed", "quarantine", id, absent))).toEqual(original);
    expect(fixture.requests.filter((request) => request.pathname.startsWith("/v1/insights/"))).toEqual([]);
    fixture.state.offline = true;
    fixture.requests.length = 0;
    const restored = await managed(fixture, directory, "--restore", id);
    expect(restored).toMatchObject({ restored: 1, conflicts: [] });
    expect(fixture.requests).toEqual([]);
    expect(readFileSync(path.join(directory, absent))).toEqual(original);
    expect(await exportedFiles(directory)).toEqual(before);
  });

  it("does not quarantine an insight that reappears after preview", async () => {
    const fixture = fixtureContext();
    const original = insight(301);
    fixture.state.insights.set(301, original);
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.insights.clear();
    const preview = await managed(fixture, directory, "--reconcile");
    expect(candidatePaths(preview)).toEqual([insightPath(301)]);
    fixture.state.insights.set(301, original);
    const before = await exportedFiles(directory);
    await expect(managed(fixture, directory, "--apply", planId(preview))).rejects.toThrow(/changed|stale|snapshot/i);
    expect(await exportedFiles(directory)).toEqual(before);
    expect(existsSync(path.join(directory, ".bee-managed", "quarantine", planId(preview)))).toBe(false);
  });

  it("refuses managed refresh, preview and apply without a complete insights endpoint", async () => {
    const fixture = fixtureContext();
    fixture.state.insights.set(301, insight(301));
    const directory = await outputDirectory();
    await managed(fixture, directory, "--managed");
    fixture.state.insights.clear();
    const preview = await managed(fixture, directory, "--reconcile");
    const before = await exportedFiles(directory);
    const inventory = readFileSync(path.join(directory, ".bee-managed", "inventory.json"));
    const plans = await readdir(path.join(directory, ".bee-managed", "plans"));
    fixture.state.insightsUnavailable = true;
    for (const args of [["--managed"], ["--reconcile"], ["--apply", planId(preview)]]) {
      await expect(managed(fixture, directory, ...args)).rejects.toThrow(/scan|request/i);
      expect(await exportedFiles(directory)).toEqual(before);
      expect(readFileSync(path.join(directory, ".bee-managed", "inventory.json"))).toEqual(inventory);
      expect(await readdir(path.join(directory, ".bee-managed", "plans"))).toEqual(plans);
    }
    const fresh = await outputDirectory();
    await expect(managed(fixture, fresh, "--managed")).rejects.toThrow(/scan|request/i);
    expect(await exportedFiles(fresh)).toEqual({});
    expect(existsSync(path.join(fresh, ".bee-managed", "inventory.json"))).toBe(false);
  });

  it("uses the existing Markdown bytes for all five targets including insight corrections and timezone folders", async () => {
    const fixture = fixtureContext();
    fixture.state.insights.set(301, { ...insight(301), timezone: "Asia/Dhaka" });
    fixture.state.insights.set(302, { ...insight(302, null), description: null, suggested_actions: [], corrections: [] });
    const managedDirectory = await outputDirectory();
    const legacyDirectory = await outputDirectory();
    await managed(fixture, managedDirectory, "--managed");
    await command(fixture, ["--full", "--output", legacyDirectory]);
    expect(process.exitCode).not.toBe(1);
    const files = await exportedFiles(managedDirectory);
    expect(files).toEqual(await exportedFiles(legacyDirectory));
    expect(files[insightPath(301, "2023-11-15")]).toContain("## Corrections\n\n- Invented correction");
    expect(files[insightPath(301, "2023-11-15")]).toContain("# Insight 301 — Invented insight 301");
    expect(files[insightPath(302)]).toContain("# Insight 302\n");
    expect(files[insightPath(302)]).toContain("## Description\n\n(empty)");
    expect(files[insightPath(302)]).toContain("## Suggested Actions\n\n- (none)");
    expect(Object.keys(files).sort()).toEqual([
      conversationPath(101), conversationPath(102), `daily/${DAY}/summary.md`, "facts.md", "todos.md",
      insightPath(301, "2023-11-15"), insightPath(302),
    ].sort());
  });
});
