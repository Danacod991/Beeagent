import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@/commands/types";
import {
  fetchManagedAccount,
  fetchManagedSnapshot,
  type SnapshotFormatters,
} from "./snapshot";

const WHEN = 1_700_000_000_000;
const fact = (id = 1) => ({ id, text: "Invented fact", tags: ["example"], created_at: WHEN, confirmed: true });
const todo = (id = 2) => ({ id, text: "Invented task", alarm_at: null, created_at: WHEN, completed: false });
const daily = (id = 3) => ({
  id, date: null, date_time: WHEN, timezone: "UTC", short_summary: "Invented day",
  summary: null, email_summary: null, calendar_summary: null, conversations_count: 0,
  locations: null, created_at: WHEN, conversations: null,
});
const conversation = (id = 4) => ({
  id, start_time: WHEN, end_time: WHEN + 10_000, timezone: "UTC", device_type: "unknown",
  summary: null, short_summary: "Invented conversation", state: "COMPLETED", created_at: WHEN,
  updated_at: WHEN, transcriptions: [{ id: 10, realtime: false, utterances: [{
    id: 11, realtime: false, start: 0, end: 1, spoken_at: WHEN, text: "Invented utterance",
    speaker: "Unknown", created_at: WHEN,
  }] }], suggested_links: [], primary_location: null,
});
const insight = (id = 5) => ({
  id, title: "Invented insight", description: "Invented insight description",
  suggested_actions: ["Invented action"], generated_at: WHEN, timezone: "UTC",
  corrections: [{ feedback: "Invented correction" }],
});

const formatters: SnapshotFormatters = {
  facts: (items) => `facts:${items.length}`,
  todos: (items) => `todos:${items.length}`,
  daily: () => ({ path: "daily/2023-11-14/summary.md", content: "Invented daily export" }),
  conversation: (item) => ({
    path: `conversations/2023-11-14/${(item as { id: number }).id}.md`,
    content: "Invented conversation export",
  }),
  insight: (item) => ({
    path: `insights/2023-11-14/${(item as { id: number }).id}.md`,
    content: "Invented insight export",
  }),
};

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function fixture(override?: Handler) {
  const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
  const context: CommandContext = {
    env: "prod",
    client: {
      env: "prod", baseUrl: "http://synthetic.invalid", isProxy: true,
      fetch: async (path, init) => {
        requests.push({ path, init });
        const overridden = override?.(path, init);
        if (overridden !== undefined) return overridden;
        const pathname = path.split("?")[0];
        const responses: Record<string, unknown> = {
          "/v1/me": { id: 101, first_name: "Invented" },
          "/v1/facts": { facts: [fact()], next_cursor: null },
          "/v1/todos": { todos: [todo()], next_cursor: null },
          "/v1/daily": { daily_summaries: [daily()], next_cursor: null },
          "/v1/conversations": { conversations: [{ id: 4 }], next_cursor: null },
          "/v1/insights": { insights: [insight()], next_cursor: null },
          "/v1/facts/1": fact(),
          "/v1/todos/2": todo(),
          "/v1/daily/3": { daily_summary: daily() },
          "/v1/conversations/4": { conversation: conversation() },
        };
        if (!pathname || !Object.hasOwn(responses, pathname)) return new Response("missing", { status: 404 });
        return Response.json(responses[pathname]);
      },
    },
  };
  return { context, requests };
}

describe("managed full snapshot", () => {
  it("reads all five unfiltered targets and details, brackets with identity, and writes nothing", async () => {
    const { context, requests } = fixture();
    const result = await fetchManagedSnapshot(context, formatters);
    expect(result.account).toMatch(/^[0-9a-f]{64}$/);
    expect(result.files).toEqual([
      { path: "conversations/2023-11-14/4.md", content: "Invented conversation export" },
      { path: "daily/2023-11-14/summary.md", content: "Invented daily export" },
      { path: "facts.md", content: "facts:1" },
      { path: "insights/2023-11-14/5.md", content: "Invented insight export" },
      { path: "todos.md", content: "todos:1" },
    ]);
    expect(requests[0]?.path).toBe("/v1/me");
    expect(requests.at(-1)?.path).toBe("/v1/me");
    expect(requests.filter((item) => item.path.includes("?"))).toHaveLength(5);
    expect(requests.some((item) => item.path.startsWith("/v1/insights/"))).toBe(false);
    for (const request of requests) {
      expect(request.init?.method).toBe("GET");
      expect(request.init?.signal).toBeDefined();
      expect(request.path).not.toMatch(/from=|since=|recent|changes/);
      expect(new Headers(request.init?.headers).has("Authorization")).toBe(false);
    }
  });

  it("continues through an empty nonterminal page until explicit null", async () => {
    const { context, requests } = fixture((path) => {
      if (path === "/v1/facts?limit=100") return Response.json({ facts: [], next_cursor: "page &2" });
      if (path === "/v1/facts?limit=100&cursor=page+%262") return Response.json({ facts: [fact()], next_cursor: null });
      return undefined;
    });
    expect((await fetchManagedSnapshot(context, formatters)).files.find((file) => file.path === "facts.md")?.content).toBe("facts:1");
    expect(requests.some((request) => request.path.endsWith("cursor=page+%262"))).toBe(true);
  });

  it.each([undefined, "", false, 0, [], {}])("refuses ambiguous terminal cursor %j", async (cursor) => {
    const { context } = fixture((path) => path === "/v1/facts?limit=100"
      ? Response.json({ facts: [], ...(cursor === undefined ? {} : { next_cursor: cursor }) })
      : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("refuses cursor cycles instead of truncating", async () => {
    const { context, requests } = fixture((path) => path.startsWith("/v1/facts?")
      ? Response.json({ facts: [], next_cursor: "same" }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
    expect(requests).toHaveLength(3);
  });

  it("refuses duplicate IDs across pages", async () => {
    const { context } = fixture((path) => path.startsWith("/v1/facts?")
      ? Response.json({ facts: [fact()], next_cursor: path.includes("cursor=") ? null : "page2" }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("collects complete insight list records across empty intermediate pages without detail requests", async () => {
    const { context, requests } = fixture((path) => {
      if (path === "/v1/insights?limit=100") return Response.json({ insights: [insight()], next_cursor: "page &2" });
      if (path === "/v1/insights?limit=100&cursor=page+%262") return Response.json({ insights: [], next_cursor: "page3" });
      if (path === "/v1/insights?limit=100&cursor=page3") return Response.json({ insights: [insight(6)], next_cursor: null });
      return undefined;
    });
    const rendered: unknown[] = [];
    const result = await fetchManagedSnapshot(context, {
      ...formatters,
      insight: (item) => { rendered.push(item); return formatters.insight(item); },
    });
    expect(rendered).toEqual([insight(), insight(6)]);
    expect(result.files.filter((file) => file.path.startsWith("insights/"))).toHaveLength(2);
    expect(requests.filter((request) => request.path.startsWith("/v1/insights"))).toEqual([
      expect.objectContaining({ path: "/v1/insights?limit=100" }),
      expect.objectContaining({ path: "/v1/insights?limit=100&cursor=page+%262" }),
      expect.objectContaining({ path: "/v1/insights?limit=100&cursor=page3" }),
    ]);
  });

  it("accepts an explicitly empty insight catalog", async () => {
    const { context } = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [], next_cursor: null }) : undefined);
    const result = await fetchManagedSnapshot(context, formatters);
    expect(result.files.some((file) => file.path.startsWith("insights/"))).toBe(false);
  });

  it("refuses an insight catalog without an explicit terminal cursor", async () => {
    const { context } = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [insight()] }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("refuses repeated insight pagination and duplicate IDs across pages", async () => {
    const repeated = fixture((path) => path.startsWith("/v1/insights?")
      ? Response.json({ insights: [], next_cursor: "same" }) : undefined);
    await expect(fetchManagedSnapshot(repeated.context, formatters)).rejects.toThrow("no complete snapshot");
    const duplicate = fixture((path) => path.startsWith("/v1/insights?")
      ? Response.json({ insights: [insight()], next_cursor: path.includes("cursor=") ? null : "page2" }) : undefined);
    await expect(fetchManagedSnapshot(duplicate.context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it.each([404, 500])("refuses a failed insight catalog (%i) without exposing upstream text", async (status) => {
    const { context } = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ error: "private insight source" }, { status }) : undefined);
    try {
      await fetchManagedSnapshot(context, formatters);
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("no complete snapshot");
      expect(String(error)).not.toContain("private insight source");
    }
  });

  const malformedInsights: Array<[string, Record<string, unknown>]> = [
    ["unsafe ID", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing title", { title: undefined }],
    ["nontext title", { title: 42 }],
    ["missing description", { description: undefined }],
    ["nontext description", { description: {} }],
    ["missing actions", { suggested_actions: undefined }],
    ["nonarray actions", { suggested_actions: "Invented action" }],
    ["nontext action", { suggested_actions: ["Invented action", 42] }],
    ["missing timestamp", { generated_at: undefined }],
    ["text timestamp", { generated_at: String(WHEN) }],
    ["negative timestamp", { generated_at: -1 }],
    ["out-of-range timestamp", { generated_at: 8_640_000_000_000_001 }],
    ["invalid timezone", { timezone: {} }],
    ["nonarray corrections", { corrections: {} }],
    ["null corrections", { corrections: null }],
    ["nonobject correction", { corrections: ["Invented correction"] }],
    ["missing feedback", { corrections: [{}] }],
    ["nontext feedback", { corrections: [{ feedback: 42 }] }],
  ];
  it.each(malformedInsights)("refuses insight %s before formatting", async (_label, fields) => {
    const { context } = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [{ ...insight(), ...fields }], next_cursor: null }) : undefined);
    let calls = 0;
    await expect(fetchManagedSnapshot(context, {
      ...formatters,
      insight: (item) => { calls += 1; return formatters.insight(item); },
    })).rejects.toThrow("no complete snapshot");
    expect(calls).toBe(0);
  });

  it("accepts nullable insight text and omitted optional fields without inventing data", async () => {
    const minimal = { id: 5, title: null, description: null, suggested_actions: [], generated_at: WHEN };
    const { context } = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [minimal], next_cursor: null }) : undefined);
    const rendered: unknown[] = [];
    await fetchManagedSnapshot(context, {
      ...formatters,
      insight: (item) => { rendered.push(item); return formatters.insight(item); },
    });
    expect(rendered).toEqual([minimal]);
  });

  it("bounds insight pagination and record counts", async () => {
    const pages = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [], next_cursor: "more" }) : undefined);
    await expect(fetchManagedSnapshot(pages.context, formatters, { maxPages: 1 })).rejects.toThrow("no complete snapshot");
    const records = fixture((path) => path === "/v1/insights?limit=100"
      ? Response.json({ insights: [insight(), insight(6)], next_cursor: null }) : undefined);
    await expect(fetchManagedSnapshot(records.context, formatters, { maxRecords: 1 })).rejects.toThrow("no complete snapshot");
  });

  it.each([0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1, null])("rejects unsafe listed ID %j", async (id) => {
    const { context } = fixture((path) => path === "/v1/facts?limit=100"
      ? Response.json({ facts: [{ id }], next_cursor: null }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("rejects a detail belonging to another ID", async () => {
    const { context } = fixture((path) => path === "/v1/conversations/4"
      ? Response.json({ conversation: conversation(44) }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("refuses a disappeared detail rather than treating it as deletion", async () => {
    const { context } = fixture((path) => path === "/v1/conversations/4"
      ? Response.json({ error: "private source leaked by upstream" }, { status: 404 }) : undefined);
    try {
      await fetchManagedSnapshot(context, formatters);
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("no complete snapshot");
      expect(String(error)).not.toContain("private source");
    }
  });

  it("refuses malformed nested transcript data before formatting", async () => {
    const { context } = fixture((path) => path === "/v1/conversations/4"
      ? Response.json({ conversation: { ...conversation(), transcriptions: [{ id: 10, realtime: false, utterances: {} }] } })
      : undefined);
    let calls = 0;
    const formatted = { ...formatters, conversation: (item: unknown) => { calls += 1; return formatters.conversation(item); } };
    await expect(fetchManagedSnapshot(context, formatted)).rejects.toThrow("no complete snapshot");
    expect(calls).toBe(0);
  });

  it("preserves nullable utterance timestamps for the renderer's start-time fallback", async () => {
    const source = conversation();
    const nullable = {
      ...source,
      transcriptions: source.transcriptions.map((transcription) => ({
        ...transcription,
        utterances: transcription.utterances.map((utterance) => ({ ...utterance, spoken_at: null })),
      })),
    };
    const { context } = fixture((path) => path === "/v1/conversations/4"
      ? Response.json({ conversation: nullable }) : undefined);
    const rendered: unknown[] = [];
    await fetchManagedSnapshot(context, {
      ...formatters,
      conversation: (item) => { rendered.push(item); return formatters.conversation(item); },
    });
    expect(rendered).toEqual([nullable]);
  });

  it("preserves a daily detail with its optional conversation count omitted", async () => {
    const source: Record<string, unknown> = { ...daily() };
    delete source["conversations_count"];
    const { context } = fixture((path) => path === "/v1/daily/3"
      ? Response.json({ daily_summary: source }) : undefined);
    const rendered: unknown[] = [];
    await fetchManagedSnapshot(context, {
      ...formatters,
      daily: (item) => { rendered.push(item); return formatters.daily(item); },
    });
    expect(rendered).toEqual([source]);
    expect(Object.hasOwn(rendered[0] as object, "conversations_count")).toBe(false);
  });

  it.each([
    ["text", "0"], ["boolean", false], ["object", {}], ["array", []],
    ["negative", -1], ["fractional", 1.5], ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "refuses a %s daily conversation count before formatting", async (_label, count) => {
      const { context } = fixture((path) => path === "/v1/daily/3"
        ? Response.json({ daily_summary: { ...daily(), conversations_count: count } }) : undefined);
      let calls = 0;
      await expect(fetchManagedSnapshot(context, {
        ...formatters,
        daily: (item) => { calls += 1; return formatters.daily(item); },
      })).rejects.toThrow("no complete snapshot");
      expect(calls).toBe(0);
    },
  );

  it.each([undefined, "2026-01-01T00:00:00Z", false, -1, 8_640_000_000_000_001])(
    "refuses invalid utterance spoken_at %j before formatting", async (spokenAt) => {
      const source = conversation();
      const { context } = fixture((path) => path === "/v1/conversations/4"
        ? Response.json({ conversation: {
          ...source,
          transcriptions: source.transcriptions.map((transcription) => ({
            ...transcription,
            utterances: transcription.utterances.map((utterance) => ({ ...utterance, spoken_at: spokenAt })),
          })),
        } }) : undefined);
      let calls = 0;
      await expect(fetchManagedSnapshot(context, {
        ...formatters,
        conversation: (item) => { calls += 1; return formatters.conversation(item); },
      })).rejects.toThrow("no complete snapshot");
      expect(calls).toBe(0);
    },
  );

  it.each(["2026-01-01T00:00:00Z", "2026-01-01T06:00:00+06:00"])(
    "preserves a valid todo alarm date string %s for the renderer", async (alarmAt) => {
      const source = { ...todo(), alarm_at: alarmAt };
      const { context } = fixture((path) => path === "/v1/todos?limit=100"
        ? Response.json({ todos: [source], next_cursor: null }) : undefined);
      const rendered: unknown[] = [];
      await fetchManagedSnapshot(context, {
        ...formatters,
        todos: (items) => { rendered.push(...items); return formatters.todos(items); },
      });
      expect(rendered).toEqual([source]);
    },
  );

  it.each([undefined, "", "not a date", "2026-13-01T00:00:00Z", "1969-12-31T23:59:59Z", false, {}, -1])(
    "refuses invalid todo alarm date %j before formatting", async (alarmAt) => {
      const { context } = fixture((path) => path === "/v1/todos?limit=100"
        ? Response.json({ todos: [{ ...todo(), alarm_at: alarmAt }], next_cursor: null }) : undefined);
      let calls = 0;
      await expect(fetchManagedSnapshot(context, {
        ...formatters,
        todos: (items) => { calls += 1; return formatters.todos(items); },
      })).rejects.toThrow("no complete snapshot");
      expect(calls).toBe(0);
    },
  );

  it("refuses invalid formatter-consumed fields", async () => {
    const { context } = fixture((path) => path === "/v1/facts?limit=100"
      ? Response.json({ facts: [{ ...fact(), tags: [42] }], next_cursor: null }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it("detects two daily IDs mapping to one output path", async () => {
    const { context } = fixture((path) => {
      if (path === "/v1/daily?limit=100") return Response.json({ daily_summaries: [{ id: 3 }, { id: 33 }], next_cursor: null });
      if (path === "/v1/daily/33") return Response.json({ daily_summary: daily(33) });
      return undefined;
    });
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("no complete snapshot");
  });

  it.each(["../escaped.md", "/absolute.md", "daily/2023-11-14/../../secret", "daily\\2023-11-14\\summary.md"])("rejects formatter path %s", async (output) => {
    const { context } = fixture();
    await expect(fetchManagedSnapshot(context, { ...formatters, daily: () => ({ path: output, content: "safe" }) })).rejects.toThrow("no complete snapshot");
  });

  it("refuses a conversation output named after another record", async () => {
    const { context } = fixture();
    await expect(fetchManagedSnapshot(context, {
      ...formatters, conversation: () => ({ path: "conversations/2023-11-14/55.md", content: "safe" }),
    })).rejects.toThrow("no complete snapshot");
  });

  it.each([
    "../insights/2023-11-14/5.md",
    "/insights/2023-11-14/5.md",
    "insights/2023-11-14/../../5.md",
    "insights\\2023-11-14\\5.md",
    "conversations/2023-11-14/5.md",
    "insights/2023-11-14/55.md",
  ])("refuses an unsafe or mismatched insight output path %s", async (output) => {
    const { context } = fixture();
    await expect(fetchManagedSnapshot(context, {
      ...formatters, insight: () => ({ path: output, content: "Invented insight export" }),
    })).rejects.toThrow("no complete snapshot");
  });

  it("sanitizes formatter errors", async () => {
    const { context } = fixture();
    await expect(fetchManagedSnapshot(context, { ...formatters, facts: () => { throw new Error("private-source-text"); } }))
      .rejects.toThrow("Managed export scan failed; no complete snapshot is available.");
  });

  it("refuses a changed identity, including through the same proxy", async () => {
    let identities = 0;
    const { context } = fixture((path) => path === "/v1/me"
      ? Response.json({ id: ++identities === 1 ? 101 : 102 }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("identity changed");
  });

  it("requires a positive safe identity and never uses a shared proxy sentinel", async () => {
    const { context } = fixture((path) => path === "/v1/me" ? Response.json({ id: "101" }) : undefined);
    await expect(fetchManagedSnapshot(context, formatters)).rejects.toThrow("invalid data");
  });

  it("returns a stable account hash across requests, while separating environments", async () => {
    const { context } = fixture();
    const first = await fetchManagedAccount(context);
    expect(await fetchManagedAccount(context)).toBe(first);
    expect(await fetchManagedAccount({ ...context, env: "staging" })).not.toBe(first);
  });

  it("fails closed at page and record limits", async () => {
    const pages = fixture((path) => path === "/v1/facts?limit=100"
      ? Response.json({ facts: [], next_cursor: "more" }) : undefined);
    await expect(fetchManagedSnapshot(pages.context, formatters, { maxPages: 1 })).rejects.toThrow("no complete snapshot");
    const records = fixture((path) => path === "/v1/facts?limit=100"
      ? Response.json({ facts: [fact(), fact(9)], next_cursor: null }) : undefined);
    await expect(fetchManagedSnapshot(records.context, formatters, { maxRecords: 1 })).rejects.toThrow("no complete snapshot");
  });

  it("bounds the number of requests and response size", async () => {
    await expect(fetchManagedSnapshot(fixture().context, formatters, { maxRequests: 1 })).rejects.toThrow("no complete snapshot");
    await expect(fetchManagedAccount(fixture().context, { maxResponseBytes: 4 })).rejects.toThrow("request failed");
    await expect(fetchManagedSnapshot(fixture().context, formatters, { maxTotalResponseBytes: 50 })).rejects.toThrow("no complete snapshot");
  });

  it("times out a transport that ignores AbortSignal", async () => {
    const { context } = fixture(() => new Promise<Response>(() => {}));
    await expect(fetchManagedAccount(context, { requestTimeoutMs: 10 })).rejects.toThrow("timed out");
  });

  it("keeps the timeout active while the response body stalls", async () => {
    let cancelled = false;
    const { context } = fixture(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":')); },
      cancel() { cancelled = true; },
    })));
    await expect(fetchManagedAccount(context, { requestTimeoutMs: 10 })).rejects.toThrow("timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("does not allow bounds to be disabled or raised", async () => {
    await expect(fetchManagedSnapshot(fixture().context, formatters, { requestTimeoutMs: 0 })).rejects.toThrow("within defaults");
    await expect(fetchManagedAccount(fixture().context, { maxPages: 201 })).rejects.toThrow("within defaults");
  });
});
