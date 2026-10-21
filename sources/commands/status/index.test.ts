import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import type { CommandContext } from "@/commands/types";
import { createProxyClient, type DeveloperClient } from "@/client";
import {
  loadPairingState,
  loadToken,
  savePairingState,
  saveToken,
} from "@/secureStore";
import { generateAppPairingKeyPair } from "@/utils/appPairingCrypto";
import { statusCommand } from "./index";

type BunServer = ReturnType<typeof Bun.serve>;

const activeServers: BunServer[] = [];

afterEach(() => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop(true);
  }
});

describe("status command", () => {
  it("shows proxy connection details in proxy mode", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          id: 1,
          first_name: "Proxy",
          last_name: "User",
        }),
    });
    activeServers.push(upstream);

    const context: CommandContext = {
      env: "prod",
      client: createProxyClient("prod", {
        address: `http://127.0.0.1:${upstream.port}`,
      }),
    };

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });

    try {
      await statusCommand.run([], context);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.some((line) => line.includes("Connected via proxy:"))).toBe(true);
    expect(logs.some((line) => line.includes("Verified as Proxy User"))).toBe(true);
  });
});

// `bee login --no-wait` saves the pairing request and exits. These tests cover
// how `bee status` treats that saved request. Global fetch is replaced for every
// test, standing in for Bee's pairing API, and /v1/me goes to a fake client.
// Both answer unexpected URLs with a 400, which the CLI does not retry, so
// nothing leaves the machine even when a test fails.
describe("status command with an unfinished login", () => {
  const API_LINE = "API: production (https://app-api-developer.ce.bee.amazon.dev/)";
  const PAIRING_API = "https://auth.beeai-services.com/apps/pairing/request";
  const PAIRING_LINK = "https://bee.computer/connect#req-123";
  const TOKEN = "test-token-0001";

  const originalConfigDir = process.env["BEE_CONFIG_DIR"];
  const originalForceFileStore = process.env["BEE_FORCE_FILE_STORE"];
  let tempDir = "";
  let fetchSpy: { mockRestore: () => void } | undefined;
  // What the pairing API stub answers, and the request bodies it received.
  let pairingAnswer: { body: unknown; status: number } = { body: {}, status: 400 };
  let pairingRequests: unknown[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bee-cli-status-"));
    process.env["BEE_CONFIG_DIR"] = tempDir;
    process.env["BEE_FORCE_FILE_STORE"] = "1";

    pairingAnswer = { body: { error: "no pairing answer set" }, status: 400 };
    pairingRequests = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== PAIRING_API) {
        return Response.json({ error: `Unexpected request to ${url}` }, { status: 400 });
      }
      try {
        pairingRequests.push(JSON.parse(String(init?.body)));
      } catch {
        pairingRequests.push(init?.body);
      }
      return Response.json(pairingAnswer.body, { status: pairingAnswer.status });
    }) as typeof fetch);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    if (originalConfigDir === undefined) {
      delete process.env["BEE_CONFIG_DIR"];
    } else {
      process.env["BEE_CONFIG_DIR"] = originalConfigDir;
    }
    if (originalForceFileStore === undefined) {
      delete process.env["BEE_FORCE_FILE_STORE"];
    } else {
      process.env["BEE_FORCE_FILE_STORE"] = originalForceFileStore;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function answerPairing(body: unknown, status = 200): void {
    pairingAnswer = { body, status };
  }

  // Saves the state `bee login --no-wait` leaves behind, for a request that
  // expires the given number of minutes from now. Returns the CLI's public key.
  async function savePendingLogin(expiresInMinutes: number): Promise<string> {
    const keyPair = generateAppPairingKeyPair();
    await savePairingState("prod", {
      appId: "test-app",
      publicKey: keyPair.publicKeyBase64,
      secretKey: Buffer.from(keyPair.secretKey).toString("base64"),
      requestId: "req-123",
      pairingUrl: PAIRING_LINK,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    });
    return keyPair.publicKeyBase64;
  }

  // The pairing API's answer once the request is approved. The token is
  // encrypted for the CLI's key: a version byte, the nonce, a one-time sender
  // public key, then the ciphertext.
  function approvedAnswer(publicKeyBase64: string, token: string): unknown {
    const sender = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(
      new TextEncoder().encode(token),
      nonce,
      Buffer.from(publicKeyBase64, "base64"),
      sender.secretKey
    );
    const encryptedToken = Buffer.concat([
      Buffer.from([1]),
      nonce,
      sender.publicKey,
      ciphertext,
    ]).toString("base64");
    return { ok: true, status: "completed", requestId: "req-123", result: { encryptedToken } };
  }

  // A developer API client whose /v1/me gives the given answer. It records the
  // Authorization header of each call.
  function developerContext(
    me: { body: unknown; status: number } = {
      body: { id: 42, first_name: "Test", last_name: "User" },
      status: 200,
    }
  ): { context: CommandContext; authorizations: string[] } {
    const authorizations: string[] = [];
    const client: DeveloperClient = {
      env: "prod",
      baseUrl: "https://app-api-developer.ce.bee.amazon.dev/",
      isProxy: false,
      fetch: async (path, init) => {
        if (path !== "/v1/me") {
          return Response.json({ error: `Unexpected request to ${path}` }, { status: 400 });
        }
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
        return Response.json(me.body, { status: me.status });
      },
    };
    return { context: { env: "prod", client }, authorizations };
  }

  async function runStatus(context: CommandContext): Promise<string[]> {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    try {
      await statusCommand.run([], context);
    } finally {
      logSpy.mockRestore();
    }
    return logs;
  }

  it("finishes a login that was approved and reports the account", async () => {
    const publicKey = await savePendingLogin(5);
    answerPairing(approvedAnswer(publicKey, TOKEN));
    const { context, authorizations } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Pending login approved. Logged in.",
      "Token: test...0001",
      "Verified as Test User (id 42).",
    ]);
    expect(pairingRequests).toEqual([{ app_id: "test-app", publicKey }]);
    expect(authorizations).toEqual([`Bearer ${TOKEN}`]);
    await expect(loadToken("prod")).resolves.toBe(TOKEN);
    await expect(loadPairingState("prod")).resolves.toBeNull();
  });

  it("repeats the link, after a single check, while approval is pending", async () => {
    await savePendingLogin(5);
    answerPairing({
      ok: true,
      status: "pending",
      requestId: "req-123",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const { context, authorizations } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Not logged in.",
      "Login pending approval.",
      `Authentication link: ${PAIRING_LINK}`,
      "This authentication request will expire in approximately 5 minutes.",
      "After approving, run 'bee status' again to finish, or run 'bee login' to wait for approval.",
    ]);
    expect(pairingRequests).toHaveLength(1);
    expect(authorizations).toEqual([]);
    await expect(loadToken("prod")).resolves.toBeNull();
    await expect(loadPairingState("prod")).resolves.not.toBeNull();
  });

  it("clears a login that Bee reports as expired", async () => {
    await savePendingLogin(5);
    answerPairing({ ok: true, status: "expired", requestId: "req-123" });
    const { context } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Not logged in.",
      "The pending login expired. Run 'bee login' to start a new one.",
    ]);
    expect(pairingRequests).toHaveLength(1);
    await expect(loadToken("prod")).resolves.toBeNull();
    await expect(loadPairingState("prod")).resolves.toBeNull();
  });

  it("clears a login past its expiry time without contacting Bee", async () => {
    await savePendingLogin(-1);
    const { context } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Not logged in.",
      "The pending login expired. Run 'bee login' to start a new one.",
    ]);
    expect(pairingRequests).toEqual([]);
    await expect(loadPairingState("prod")).resolves.toBeNull();
  });

  it("prints only 'Not logged in.' when no login is pending", async () => {
    const { context, authorizations } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([API_LINE, "Not logged in."]);
    expect(pairingRequests).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it("treats a saved request with missing fields as no pending login", async () => {
    writeFileSync(
      join(tempDir, "pairing-prod.json"),
      JSON.stringify({ requestId: "req-123", pairingUrl: PAIRING_LINK })
    );
    const { context } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([API_LINE, "Not logged in."]);
    expect(pairingRequests).toEqual([]);
  });

  it("reports a failed check and keeps the pending login", async () => {
    await savePendingLogin(5);
    answerPairing({ error: "bad_request" }, 400);
    const { context } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Not logged in.",
      "Could not finish the pending login: bad_request",
    ]);
    await expect(loadToken("prod")).resolves.toBeNull();
    await expect(loadPairingState("prod")).resolves.not.toBeNull();
  });

  it("stores nothing when Bee rejects the approved token, and clears the login like 'bee login'", async () => {
    const publicKey = await savePendingLogin(5);
    answerPairing(approvedAnswer(publicKey, TOKEN));
    const { context } = developerContext({ body: { error: "Unauthorized" }, status: 401 });

    const logs = await runStatus(context);

    expect(logs).toEqual([
      API_LINE,
      "Not logged in.",
      "Could not finish the pending login: Unauthorized",
    ]);
    await expect(loadToken("prod")).resolves.toBeNull();
    await expect(loadPairingState("prod")).resolves.toBeNull();
  });

  it("uses a stored token and leaves any pending login alone", async () => {
    await saveToken("prod", "stored-token-1234");
    await savePendingLogin(5);
    const { context, authorizations } = developerContext();

    const logs = await runStatus(context);

    expect(logs).toEqual([API_LINE, "Token: stor...1234", "Verified as Test User (id 42)."]);
    expect(pairingRequests).toEqual([]);
    expect(authorizations).toEqual(["Bearer stored-token-1234"]);
    await expect(loadPairingState("prod")).resolves.not.toBeNull();
  });
});
