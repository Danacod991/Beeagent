import { createHash } from "node:crypto";
import type { CommandContext } from "@/commands/types";
import { requireClientToken } from "@/client/clientApi";

export type ManagedFile = { path: string; content: string };

// The caller provides the existing sync formatters. Keeping this dependency
// explicit avoids a cycle through the command entry point.
export type SnapshotFormatters = {
  facts: (records: unknown[]) => string;
  todos: (records: unknown[]) => string;
  daily: (record: unknown) => ManagedFile;
  conversation: (record: unknown) => ManagedFile;
  insight: (record: unknown) => ManagedFile;
};

export type SnapshotLimits = {
  requestTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  maxPages?: number;
  maxRecords?: number;
  maxResponseBytes?: number;
  maxTotalResponseBytes?: number;
  maxRequests?: number;
};

const DEFAULTS = {
  requestTimeoutMs: 10_000,
  snapshotTimeoutMs: 120_000,
  maxPages: 200,
  maxRecords: 20_000,
  maxResponseBytes: 16 * 1024 * 1024,
  maxTotalResponseBytes: 64 * 1024 * 1024,
  maxRequests: 25_000,
};
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
type Limits = typeof DEFAULTS;
type RecordValue = Record<string, unknown>;
type Target = "facts" | "todos" | "daily" | "conversations" | "insights";
type ReadJson = (path: string) => Promise<unknown>;

function fail(message = "Managed export scan received invalid data."): never {
  throw new Error(message);
}

function limitsFor(options: SnapshotLimits): Limits {
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof Limits>) {
    const value = options[key];
    if (value === undefined) continue;
    // Options may lower bounds for embedding/tests, never disable the bounds.
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULTS[key]) {
      fail("Managed export scan limits must be positive and within defaults.");
    }
    limits[key] = value;
  }
  return limits;
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as RecordValue;
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail();
  return value;
}

function text(value: unknown): void {
  if (typeof value !== "string") fail();
}

function nullableText(value: unknown): void {
  if (value !== null) text(value);
}

function boolean(value: unknown): void {
  if (typeof value !== "boolean") fail();
}

function timestamp(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) ||
      value < 0 || value > 8_640_000_000_000_000) fail();
}

function nullableTimestamp(value: unknown): void {
  if (value !== null) timestamp(value);
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}

function timezone(value: unknown): void {
  if (value !== undefined && value !== null) text(value);
}

function location(value: unknown, withCreatedAt: boolean): void {
  if (value === null) return;
  const item = record(value);
  const latitude = item["latitude"];
  const longitude = item["longitude"];
  if (typeof latitude !== "number" || !Number.isFinite(latitude) ||
      latitude < -90 || latitude > 90 || typeof longitude !== "number" ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) fail();
  nullableText(item["address"]);
  if (withCreatedAt) timestamp(item["created_at"]);
}

function validateFact(value: unknown, id: number): RecordValue {
  const item = record(value);
  if (positiveId(item["id"]) !== id) fail();
  text(item["text"]);
  array(item["tags"]).forEach(text);
  timestamp(item["created_at"]);
  boolean(item["confirmed"]);
  return item;
}

function validateTodo(value: unknown, id: number): RecordValue {
  const item = record(value);
  if (positiveId(item["id"]) !== id) fail();
  text(item["text"]);
  // The todo resource also permits date strings. Validate their rendered date
  // while preserving the original value for the ordinary sync formatter.
  const alarm = item["alarm_at"];
  nullableTimestamp(typeof alarm === "string" ? Date.parse(alarm) : alarm);
  timestamp(item["created_at"]);
  boolean(item["completed"]);
  return item;
}

function validateDaily(value: unknown, id: number): RecordValue {
  const item = record(record(value)["daily_summary"]);
  if (positiveId(item["id"]) !== id) fail();
  nullableText(item["date"]);
  nullableTimestamp(item["date_time"]);
  timezone(item["timezone"]);
  text(item["short_summary"]);
  for (const key of ["summary", "email_summary", "calendar_summary"]) nullableText(item[key]);
  const count = item["conversations_count"];
  // Some daily detail responses omit this optional display field. The existing
  // renderer displays n/a for both missing and null counts.
  if (count !== undefined && count !== null &&
      (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) fail();
  nullableTimestamp(item["created_at"]);
  if (item["locations"] !== null) {
    for (const entry of array(item["locations"])) {
      const place = record(entry);
      if (place["id"] !== null) positiveId(place["id"]);
      location(place, false);
    }
  }
  if (item["conversations"] !== null) {
    for (const entry of array(item["conversations"])) {
      const conversation = record(entry);
      positiveId(conversation["id"]);
      timestamp(conversation["start_time"]);
      nullableTimestamp(conversation["end_time"]);
      nullableText(conversation["short_summary"]);
    }
  }
  return item;
}

function validateConversation(value: unknown, id: number): RecordValue {
  const item = record(record(value)["conversation"]);
  if (positiveId(item["id"]) !== id) fail();
  timestamp(item["start_time"]);
  nullableTimestamp(item["end_time"]);
  timestamp(item["created_at"]);
  timestamp(item["updated_at"]);
  timezone(item["timezone"]);
  text(item["device_type"]);
  text(item["state"]);
  nullableText(item["summary"]);
  nullableText(item["short_summary"]);
  location(item["primary_location"], true);
  for (const entry of array(item["suggested_links"])) {
    const link = record(entry);
    text(link["url"]);
    timestamp(link["created_at"]);
  }
  for (const entry of array(item["transcriptions"])) {
    const transcription = record(entry);
    positiveId(transcription["id"]);
    boolean(transcription["realtime"]);
    for (const value of array(transcription["utterances"])) {
      const utterance = record(value);
      positiveId(utterance["id"]);
      boolean(utterance["realtime"]);
      nullableTimestamp(utterance["start"]);
      nullableTimestamp(utterance["end"]);
      nullableTimestamp(utterance["spoken_at"]);
      timestamp(utterance["created_at"]);
      text(utterance["text"]);
      text(utterance["speaker"]);
    }
  }
  return item;
}

function validateInsight(value: unknown, id: number): RecordValue {
  const item = record(value);
  if (positiveId(item["id"]) !== id) fail();
  nullableText(item["title"]);
  nullableText(item["description"]);
  array(item["suggested_actions"]).forEach(text);
  timestamp(item["generated_at"]);
  timezone(item["timezone"]);
  if (item["corrections"] !== undefined) {
    for (const correction of array(item["corrections"])) text(record(correction)["feedback"]);
  }
  return item;
}

async function readBody(response: Response, maximum: number, signal: AbortSignal): Promise<{ value: unknown; bytes: number }> {
  if (!response.body) fail();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) fail("Managed export scan timed out.");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) fail("Managed export scan response exceeded its size bound.");
      chunks.push(next.value);
    }
    if (signal.aborted) fail("Managed export scan timed out.");
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown, bytes: size };
  } catch {
    // Cancel without awaiting an untrusted stream's cancellation promise.
    void reader.cancel().catch(() => {});
    fail("Managed export scan could not read a complete bounded JSON response.");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function createReader(context: CommandContext, limits: Limits): ReadJson {
  const deadline = Date.now() + limits.snapshotTimeoutMs;
  let requests = 0;
  let responseBytes = 0;
  return async (path) => {
    requests += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0 || requests > limits.maxRequests) fail("Managed export scan exceeded its execution bound.");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Managed export scan request timed out."));
      }, Math.min(limits.requestTimeoutMs, remaining));
    });
    const operation = async (): Promise<unknown> => {
      try {
        const token = await requireClientToken(context);
        if (controller.signal.aborted) fail();
        const headers = new Headers({ Accept: "application/json" });
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const response = await context.client.fetch(path, {
          method: "GET", headers, signal: controller.signal,
        });
        if (controller.signal.aborted || !response.ok) {
          void response.body?.cancel().catch(() => {});
          fail();
        }
        const result = await readBody(response, Math.min(
          limits.maxResponseBytes, limits.maxTotalResponseBytes - responseBytes
        ), controller.signal);
        responseBytes += result.bytes;
        return result.value;
      } catch {
        // Never forward upstream bodies, transport exceptions or token errors.
        fail("Managed export scan request failed or returned invalid data.");
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  };
}

async function accountFrom(read: ReadJson, context: CommandContext): Promise<string> {
  const identity = record(await read("/v1/me"));
  const id = positiveId(identity["id"]);
  return createHash("sha256").update(`bee-managed-account-v1:${context.env}:${id}`).digest("hex");
}

/** Read the current authenticated identity without exposing its ID or token. */
export async function fetchManagedAccount(
  context: CommandContext,
  options: SnapshotLimits = {}
): Promise<string> {
  return accountFrom(createReader(context, limitsFor(options)), context);
}

async function listRecords(read: ReadJson, target: Target, limits: Limits): Promise<RecordValue[]> {
  const key = target === "daily" ? "daily_summaries" : target;
  const records: RecordValue[] = [];
  const seenIds = new Set<number>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < limits.maxPages; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor !== null) params.set("cursor", cursor);
    const payload = record(await read(`/v1/${target}?${params.toString()}`));
    for (const value of array(payload[key])) {
      const item = record(value);
      const id = positiveId(item["id"]);
      if (seenIds.has(id)) fail("Managed export scan found a duplicate record.");
      seenIds.add(id);
      records.push(item);
      if (records.length > limits.maxRecords) fail("Managed export scan exceeded its record bound.");
    }
    // Missing, empty or malformed cursors are never interpreted as completion.
    if (!Object.hasOwn(payload, "next_cursor")) fail();
    const next = payload["next_cursor"];
    if (next === null) return records;
    if (typeof next !== "string" || next.length === 0 || next.length > 4096 || seenCursors.has(next)) {
      fail("Managed export scan received invalid or repeated pagination.");
    }
    seenCursors.add(next);
    cursor = next;
  }
  fail("Managed export scan exceeded its page bound.");
}

function checkedFile(value: ManagedFile, expected: "facts" | "todos" | "daily" | "conversation" | "insight"): ManagedFile {
  if (!value || typeof value.path !== "string" || typeof value.content !== "string") fail();
  const patterns = {
    facts: /^facts\.md$/,
    todos: /^todos\.md$/,
    daily: /^daily\/\d{4}-\d{2}-\d{2}\/summary\.md$/,
    conversation: /^conversations\/\d{4}-\d{2}-\d{2}\/[1-9]\d*\.md$/,
    insight: /^insights\/\d{4}-\d{2}-\d{2}\/[1-9]\d*\.md$/,
  };
  if (!patterns[expected].test(value.path)) fail("Managed export formatter produced an invalid path.");
  return value;
}

/**
 * Read a full unfiltered catalog and all details without writing local files.
 * A missing item is only absent from this scan: neither these endpoints nor
 * their cursors establish a server deletion or an atomic snapshot.
 */
export async function fetchManagedSnapshot(
  context: CommandContext,
  formatters: SnapshotFormatters,
  options: SnapshotLimits = {}
): Promise<{ account: string; files: ManagedFile[] }> {
  const limits = limitsFor(options);
  const read = createReader(context, limits);
  const account = await accountFrom(read, context);
  const facts: unknown[] = [];
  const todos: unknown[] = [];
  const files: ManagedFile[] = [];
  const paths = new Set<string>();
  let outputBytes = 0;
  const add = (value: ManagedFile, kind: Parameters<typeof checkedFile>[1]) => {
    const file = checkedFile(value, kind);
    if (paths.has(file.path)) fail("Managed export scan found an output path collision.");
    outputBytes += Buffer.byteLength(file.content, "utf8");
    if (outputBytes > MAX_OUTPUT_BYTES) fail("Managed export scan exceeded its output size bound.");
    paths.add(file.path);
    files.push(file);
  };
  try {
    for (const target of ["facts", "todos", "daily", "conversations", "insights"] as const) {
      const records = await listRecords(read, target, limits);
      for (const item of records) {
        const id = positiveId(item["id"]);
        // Facts/todos/insights list entries contain their complete export fields,
        // matching ordinary sync without a redundant per-item request.
        if (target === "facts") facts.push(validateFact(item, id));
        else if (target === "todos") todos.push(validateTodo(item, id));
        else if (target === "daily") {
          add(formatters.daily(validateDaily(await read(`/v1/daily/${id}`), id)), "daily");
        } else if (target === "conversations") {
          const file = formatters.conversation(validateConversation(await read(`/v1/conversations/${id}`), id));
          if (!file.path.endsWith(`/${id}.md`)) fail();
          add(file, "conversation");
        } else {
          const file = formatters.insight(validateInsight(item, id));
          if (!file.path.endsWith(`/${id}.md`)) fail();
          add(file, "insight");
        }
      }
    }
    add({ path: "facts.md", content: formatters.facts(facts) }, "facts");
    add({ path: "todos.md", content: formatters.todos(todos) }, "todos");
  } catch {
    // Formatter exceptions can contain source text. The public diagnostic must
    // remain independent of all captured data and server-provided strings.
    fail("Managed export scan failed; no complete snapshot is available.");
  }
  if (await accountFrom(read, context) !== account) fail("Managed export scan identity changed; snapshot refused.");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { account, files };
}
