// Local server behind `bee voice`: serves the voice page and relays what the
// user said to the Bee agent through the Threads API. The browser does the
// speech recognition and synthesis; this process only handles text.
import type { CommandContext } from "@/commands/types";
import {
  abortThread,
  sendAndWait,
  ThreadsApiError,
  ThreadsInterruptedError,
  waitForAnswer,
  type ThreadAnswer,
} from "@/resources/threads/api";
import { isAddressInUseError, isBearerAuthorized, isLocalRequest, secureEqual } from "@/utils/localHttp";
import pageHtml from "./page.html" with { type: "text" };

// The text import embeds the file as a string; bun-types describes every
// .html import as an HTMLBundle regardless of the import attribute.
const page = pageHtml as unknown as string;

export const DEFAULT_VOICE_PORT = 8795;
const MAX_PORT_ATTEMPTS = 50;
const IDLE_TIMEOUT_SECONDS = 120;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT_LENGTH = 100_000;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

// One browser request waits this long at most; the page keeps calling
// /api/wait while the answer is pending, so no request outlives the server's
// idle timeout or a browser's patience.
const DEFAULT_WAIT_MS = 50_000;

// Wrong passwords allowed per window, across all clients, before /api/login
// answers 429. With the minimum password length this makes guessing hopeless.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export type VoiceServerOptions = {
  // Bearer token every /api call must present.
  token: string;
  // Set when the page is reachable from other devices: the page asks for this
  // password and /api/login trades it for the token. Without it the server
  // only answers requests addressed to this machine, and the token reaches
  // the page in the link's fragment.
  password?: string;
  // Address to listen on; defaults to 127.0.0.1.
  host?: string;
  // Serve HTTPS with this certificate instead of plain HTTP.
  tls?: { certPath: string; keyPath: string };
  port?: number;
  // Thread the page starts on; null starts a new thread with the first message.
  threadId: string | null;
  // BCP 47 tag for recognition and speech; null lets the browser decide.
  lang: string | null;
  waitMs?: number;
};

export type VoiceServer = {
  server: ReturnType<typeof Bun.serve>;
  port: number;
};

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function startVoiceServer(context: CommandContext, options: VoiceServerOptions): VoiceServer {
  const fetch = async (request: Request): Promise<Response> =>
    await handleVoiceRequest(request, context, options);
  const tryStart = (port: number): ReturnType<typeof Bun.serve> | null => tryServe(port, options, fetch);

  if (options.port !== undefined) {
    const server = tryStart(options.port);
    if (!server) {
      throw new Error(`Port ${options.port} is in use. Choose another with --port.`);
    }
    return { server, port: options.port };
  }
  for (let offset = 0; offset <= MAX_PORT_ATTEMPTS; offset += 1) {
    const port = DEFAULT_VOICE_PORT + offset;
    const server = tryStart(port);
    if (server) {
      return { server, port };
    }
  }
  throw new Error("No free port found. Specify one with --port.");
}

function tryServe(
  port: number,
  options: VoiceServerOptions,
  fetch: (request: Request) => Promise<Response>
): ReturnType<typeof Bun.serve> | null {
  try {
    return Bun.serve({
      hostname: options.host ?? "127.0.0.1",
      port,
      ...(options.tls
        ? { tls: { cert: Bun.file(options.tls.certPath), key: Bun.file(options.tls.keyPath) } }
        : {}),
      idleTimeout: IDLE_TIMEOUT_SECONDS,
      maxRequestBodySize: MAX_BODY_BYTES,
      fetch,
    });
  } catch (error) {
    if (isAddressInUseError(error)) {
      return null;
    }
    throw error;
  }
}

export async function handleVoiceRequest(
  request: Request,
  context: CommandContext,
  options: VoiceServerOptions
): Promise<Response> {
  // Link mode trusts only requests addressed to this machine. Password mode is
  // meant to be reached from elsewhere, often through a reverse proxy that
  // rewrites Host, so there the bearer token alone decides; it is a header the
  // page sets itself, which another website cannot make a browser send.
  const password = options.password;
  if (password === undefined && !isLocalRequest(request)) {
    return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  }

  const { pathname } = new URL(request.url);

  // The page holds no secrets: every /api call must present the token, which
  // the page gets from the link's fragment or from /api/login.
  if (pathname === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET");
    }
    return new Response(page, { headers: PAGE_HEADERS });
  }

  if (!pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }
  if (pathname === "/api/login" && password !== undefined) {
    if (request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    return await login(request, options, password);
  }
  if (!isBearerAuthorized(request, options.token)) {
    return password === undefined
      ? json({ error: "This page's session is not valid. Open the link printed by `bee voice` again." }, 401)
      : json({ error: "Enter the password to continue.", login: true }, 401);
  }

  if (pathname === "/api/session") {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return json({ thread_id: options.threadId, lang: options.lang });
  }

  const handler = API[pathname];
  if (!handler) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const body = await readBody(request);
  if (body === null) {
    return json({ error: "The request body must be a JSON object." }, 400);
  }

  try {
    return await handler(context, body, options.waitMs ?? DEFAULT_WAIT_MS);
  } catch (error) {
    return errorResponse(error);
  }
}

type Body = { readonly [key: string]: unknown };

async function readBody(request: Request): Promise<Body | null> {
  try {
    const parsed = JSON.parse(await request.text()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Body;
  } catch {
    return null;
  }
}

// Times of recent wrong passwords, per running server.
const loginFailures = new WeakMap<VoiceServerOptions, number[]>();

async function login(request: Request, options: VoiceServerOptions, password: string): Promise<Response> {
  const now = Date.now();
  const failures = (loginFailures.get(options) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  loginFailures.set(options, failures);
  if (failures.length >= LOGIN_MAX_FAILURES) {
    return json({ error: "Too many wrong passwords. Try again in a few minutes.", login: true }, 429);
  }
  const body = await readBody(request);
  const given = body?.["password"];
  if (typeof given !== "string" || !secureEqual(given, password)) {
    failures.push(now);
    return json({ error: "Wrong password.", login: true }, 401);
  }
  return json({ token: options.token });
}
type Handler = (context: CommandContext, body: Body, waitMs: number) => Promise<Response>;

class BadRequest extends Error {}

const API: { readonly [path: string]: Handler } = {
  // Sends what the user said. The page re-sends with the same
  // client_message_id after a failure, which resumes instead of duplicating.
  "/api/message": async (context, body, waitMs) => {
    const text = typeof body["text"] === "string" ? body["text"].trim() : "";
    if (text.length === 0) {
      throw new BadRequest("text is required.");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BadRequest(`text must be at most ${MAX_TEXT_LENGTH} characters.`);
    }
    const clientMessageId = body["client_message_id"];
    if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID.test(clientMessageId)) {
      throw new BadRequest("client_message_id must be 1-128 characters of A-Z, a-z, 0-9, '.', '_', ':' or '-'.");
    }
    const answer = await sendAndWait(context, {
      threadId: optionalId(body, "thread_id"),
      text,
      fileIds: [],
      clientMessageId,
      timeoutMs: waitMs,
      onWaiting: undefined,
    });
    return json(answerBody(answer));
  },

  "/api/wait": async (context, body, waitMs) => {
    const answer = await waitForAnswer(context, {
      threadId: requiredId(body, "thread_id"),
      after: optionalId(body, "after") ?? undefined,
      timeoutMs: waitMs,
      onWaiting: undefined,
    });
    return json(answerBody(answer));
  },

  "/api/abort": async (context, body) => {
    await abortThread(context, requiredId(body, "thread_id"));
    return json({ ok: true });
  },
};

function optionalId(body: Body, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new BadRequest(`${key} must be a string of 1-255 characters.`);
  }
  return value;
}

function requiredId(body: Body, key: string): string {
  const value = optionalId(body, key);
  if (value === null) {
    throw new BadRequest(`${key} is required.`);
  }
  return value;
}

function answerBody(answer: ThreadAnswer): { [key: string]: string | null } {
  return {
    status: answer.status,
    thread_id: answer.thread_id,
    message_id: answer.message_id,
    text: answer.text ?? null,
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof BadRequest) {
    return json({ error: error.message }, 400);
  }
  if (error instanceof ThreadsApiError) {
    // Bee refused the request; sending the same thing again will not help.
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    return json({ error: error.message, code: error.code, retryable: false }, status);
  }
  if (error instanceof ThreadsInterruptedError) {
    return json({
      error: error.message,
      retryable: true,
      thread_id: error.threadId,
      message_id: error.messageId,
    }, 502);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return json({ error: message, retryable: false }, 500);
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow, "cache-control": "no-store" },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
