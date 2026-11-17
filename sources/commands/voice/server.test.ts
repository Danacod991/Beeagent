import { afterEach, describe, expect, it } from "bun:test";
import type { CommandContext } from "@/commands/types";
import { parseVoiceArgs } from "@/commands/voice";
import { handleVoiceRequest, startVoiceServer, type VoiceServerOptions } from "@/commands/voice/server";

const TOKEN = "0123456789abcdef0123456789abcdef";
const OPTIONS: VoiceServerOptions = { token: TOKEN, threadId: null, lang: null, waitMs: 2_000 };

type Call = { path: string; method: string; body: unknown };

// A Bee server stand-in: records each call and answers from `respond`.
function fakeContext(respond: (call: Call) => Response): { context: CommandContext; calls: Call[] } {
  const calls: Call[] = [];
  const context: CommandContext = {
    env: "prod",
    client: {
      env: "prod",
      baseUrl: "http://127.0.0.1/",
      isProxy: true,
      fetch: async (path, init) => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
        const call = { path: String(path), method: init?.method ?? "GET", body };
        calls.push(call);
        return respond(call);
      },
    },
  };
  return { context, calls };
}

function request(path: string, init: { method?: string; body?: unknown; token?: string | null; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { host: "localhost:8795", ...init.headers };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new Request(`http://localhost:8795${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const completed = { status: "completed", thread_id: "t1", message_id: "m1", text: "Hello there", messages: [] };

describe("voice server", () => {
  it("serves the page without a token and with a restrictive CSP", async () => {
    const { context } = fakeContext(() => Response.json({}));
    const response = await handleVoiceRequest(request("/", { token: null }), context, OPTIONS);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Bee");
    expect(html).not.toContain(TOKEN);
  });

  it("rejects API calls without the session token", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    for (const token of [null, "wrong"]) {
      const response = await handleVoiceRequest(
        request("/api/message", { token, body: { text: "hi", client_message_id: "c1" } }), context, OPTIONS);
      expect(response.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects requests from another host or origin", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const rebinding = await handleVoiceRequest(request("/api/session", { headers: { host: "evil.example" } }), context, OPTIONS);
    expect(rebinding.status).toBe(403);
    const crossSite = await handleVoiceRequest(request("/api/session", { headers: { origin: "https://evil.example" } }), context, OPTIONS);
    expect(crossSite.status).toBe(403);
  });

  it("reports the configured thread and language", async () => {
    const { context } = fakeContext(() => Response.json({}));
    const response = await handleVoiceRequest(request("/api/session"), context, { ...OPTIONS, threadId: "t9", lang: "de-DE" });
    expect(await response.json()).toEqual({ thread_id: "t9", lang: "de-DE" });
  });

  it("starts a thread with the first message and returns the answer", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/api/message", { body: { text: "  What's on today?  ", thread_id: null, client_message_id: "c1" } }), context, OPTIONS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed", thread_id: "t1", message_id: "m1", text: "Hello there" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/v1/threads");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ text: "What's on today?", file_ids: [], client_message_id: "c1" });
  });

  it("sends follow-ups to the existing thread", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    await handleVoiceRequest(
      request("/api/message", { body: { text: "And tomorrow?", thread_id: "t1", client_message_id: "c2" } }), context, OPTIONS);
    expect(calls[0]?.path).toBe("/v1/threads/t1/messages");
  });

  it("validates the message body", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    const bodies: unknown[] = [
      { text: "   ", client_message_id: "c1" },
      { text: "hi" },
      { text: "hi", client_message_id: "bad id!" },
      { text: "hi", client_message_id: "c1", thread_id: 7 },
      ["hi"],
    ];
    for (const body of bodies) {
      const response = await handleVoiceRequest(request("/api/message", { body }), context, OPTIONS);
      expect(response.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("passes Bee's refusals through as non-retryable errors", async () => {
    const { context } = fakeContext(() => Response.json({ error: "test_user_required" }, { status: 403 }));
    const response = await handleVoiceRequest(
      request("/api/message", { body: { text: "hi", client_message_id: "c1" } }), context, OPTIONS);
    expect(response.status).toBe(403);
    const body = await response.json() as { error: string; retryable: boolean };
    expect(body.error).toContain("test users only");
    expect(body.retryable).toBe(false);
  });

  it("waits on a thread after a message", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/api/wait", { body: { thread_id: "t1", after: "m0" } }), context, OPTIONS);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("completed");
    expect(calls[0]?.path).toContain("/v1/threads/t1/");
    const missing = await handleVoiceRequest(request("/api/wait", { body: {} }), context, OPTIONS);
    expect(missing.status).toBe(400);
  });

  it("aborts a thread", async () => {
    const { context, calls } = fakeContext(() => Response.json({ ok: true }));
    const response = await handleVoiceRequest(request("/api/abort", { body: { thread_id: "t1" } }), context, OPTIONS);
    expect(response.status).toBe(200);
    expect(calls[0]?.path).toContain("/v1/threads/t1/");
    expect(calls[0]?.method).toBe("POST");
  });

  it("answers 404 and 405 for unknown paths and methods", async () => {
    const { context } = fakeContext(() => Response.json({}));
    expect((await handleVoiceRequest(request("/nope"), context, OPTIONS)).status).toBe(404);
    expect((await handleVoiceRequest(request("/api/nope", { body: {} }), context, OPTIONS)).status).toBe(404);
    expect((await handleVoiceRequest(request("/api/message"), context, OPTIONS)).status).toBe(405);
  });
});

describe("voice server over HTTP", () => {
  let server: ReturnType<typeof startVoiceServer>["server"] | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  it("listens on the requested port and refuses a port in use", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const started = startVoiceServer(context, { ...OPTIONS, port: 18795 });
    server = started.server;
    expect(started.port).toBe(18795);
    const page = await fetch("http://127.0.0.1:18795/");
    expect(page.status).toBe(200);
    await page.text();
    expect(() => startVoiceServer(context, { ...OPTIONS, port: 18795 })).toThrow("Port 18795 is in use");
  });
});

describe("parseVoiceArgs", () => {
  it("defaults to a new thread and opening the browser", () => {
    expect(parseVoiceArgs([])).toEqual(
      { threadId: null, lang: null, open: true, host: null, password: null, tlsCert: null, tlsKey: null });
  });

  it("parses every flag", () => {
    expect(parseVoiceArgs(["--thread", "t1", "--lang", "de-DE", "--port", "9000", "--no-open"]))
      .toEqual({ threadId: "t1", lang: "de-DE", port: 9000, open: false, host: null, password: null, tlsCert: null, tlsKey: null });
  });

  it("rejects bad values", () => {
    expect(() => parseVoiceArgs(["--port", "0"])).toThrow("--port");
    expect(() => parseVoiceArgs(["--port"])).toThrow("requires a value");
    expect(() => parseVoiceArgs(["--lang", "not a tag"])).toThrow("--lang");
    expect(() => parseVoiceArgs(["extra"])).toThrow("Unexpected argument");
  });
});

const SHARED: VoiceServerOptions = { ...OPTIONS, password: "hunter2hunter2", host: "0.0.0.0" };

describe("voice server with a password", () => {
  it("serves the page to a request from another host", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/", { token: null, headers: { host: "phone.local:8795" } }), context, SHARED);
    expect(response.status).toBe(200);
    await response.text();
  });

  it("trades the right password for the session token", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/api/login", { token: null, body: { password: "hunter2hunter2" } }), context, SHARED);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: TOKEN });
  });

  it("refuses a wrong password and rate-limits guessing", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    // A fresh options object so this test gets its own failure counter.
    const options: VoiceServerOptions = { ...SHARED };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await handleVoiceRequest(
        request("/api/login", { token: null, body: { password: "wrong-password" } }), context, options);
      expect(response.status).toBe(401);
      expect((await response.json() as { login: boolean }).login).toBe(true);
    }
    const limited = await handleVoiceRequest(
      request("/api/login", { token: null, body: { password: "wrong-password" } }), context, options);
    expect(limited.status).toBe(429);
    // Even the correct password waits out the window.
    const correct = await handleVoiceRequest(
      request("/api/login", { token: null, body: { password: "hunter2hunter2" } }), context, options);
    expect(correct.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it("tells an unauthenticated API caller to log in", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(request("/api/session", { token: null }), context, SHARED);
    expect(response.status).toBe(401);
    expect((await response.json() as { login: boolean }).login).toBe(true);
  });

  it("still requires the token for the API", async () => {
    const { context, calls } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/api/message", { token: "wrong", body: { text: "hi", client_message_id: "c1" } }), context, SHARED);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("has no login route when no password is set", async () => {
    const { context } = fakeContext(() => Response.json(completed));
    const response = await handleVoiceRequest(
      request("/api/login", { token: null, body: { password: "hunter2hunter2" } }), context, OPTIONS);
    expect(response.status).toBe(401);
    expect((await response.json() as { login?: boolean }).login).toBeUndefined();
  });
});

describe("parseVoiceArgs for shared access", () => {
  it("parses the host, password and certificate flags", () => {
    const options = parseVoiceArgs(["--host", "0.0.0.0", "--password", "hunter2hunter2"]);
    expect(options.host).toBe("0.0.0.0");
    expect(options.password).toBe("hunter2hunter2");
  });

  it("takes the password from the environment", () => {
    expect(parseVoiceArgs([], "hunter2hunter2").password).toBe("hunter2hunter2");
    expect(parseVoiceArgs(["--password", "flagflagflag"], "hunter2hunter2").password).toBe("flagflagflag");
    expect(parseVoiceArgs([], "").password).toBeNull();
  });

  it("rejects a short password and a half-given certificate", () => {
    expect(() => parseVoiceArgs(["--password", "short"])).toThrow("at least 8 characters");
    expect(() => parseVoiceArgs([], "short")).toThrow("at least 8 characters");
    expect(() => parseVoiceArgs(["--tls-cert", "/tmp/cert.pem"])).toThrow("must be given together");
    expect(() => parseVoiceArgs(["--tls-cert", "/nope.pem", "--tls-key", "/nope.pem"])).toThrow("No such file");
  });
});
