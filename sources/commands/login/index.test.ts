import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { createDeveloperClient } from "@/client";
import { loadPairingState, loadToken, savePairingState } from "@/secureStore";
import { generateAppPairingKeyPair } from "@/utils/appPairingCrypto";
import { loginCommand, parseLoginArgs, validateProxyConnection } from "./index";

type BunServer = ReturnType<typeof Bun.serve>;

const activeServers: BunServer[] = [];
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop(true);
  }
  for (const path of cleanupPaths.splice(0, cleanupPaths.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("login command", () => {
  it("parses --proxy flag", () => {
    expect(parseLoginArgs(["--proxy", "http://127.0.0.1:8787"])).toEqual({
      proxy: "http://127.0.0.1:8787",
      tokenStdin: false,
      qr: false,
      noWait: false,
    });
  });

  it("parses --no-wait flag (defaults off)", () => {
    expect(parseLoginArgs([])).toEqual({ tokenStdin: false, qr: false, noWait: false });
    expect(parseLoginArgs(["--no-wait"])).toEqual({ tokenStdin: false, qr: false, noWait: true });
  });

  it("allows --no-wait with --qr", () => {
    expect(parseLoginArgs(["--no-wait", "--qr"])).toEqual({
      tokenStdin: false,
      qr: true,
      noWait: true,
    });
  });

  it("rejects --no-wait with --token", () => {
    expect(() => parseLoginArgs(["--no-wait", "--token", "abc"])).toThrow(
      "--no-wait cannot be used with --token or --token-stdin."
    );
  });

  it("rejects --no-wait with --token-stdin", () => {
    expect(() => parseLoginArgs(["--no-wait", "--token-stdin"])).toThrow(
      "--no-wait cannot be used with --token or --token-stdin."
    );
  });

  it("rejects --no-wait with --proxy", () => {
    expect(() => parseLoginArgs(["--no-wait", "--proxy", "http://127.0.0.1:8787"])).toThrow(
      "--no-wait cannot be used with --proxy."
    );
  });

  it("rejects --proxy with --token", () => {
    expect(() => parseLoginArgs(["--proxy", "http://127.0.0.1:8787", "--token", "abc"])).toThrow(
      "Use either --proxy or --token, not both."
    );
  });

  it("rejects --proxy with --token-stdin", () => {
    expect(() => parseLoginArgs(["--proxy", "/tmp/proxy.sock", "--token-stdin"])).toThrow(
      "Use either --proxy or --token-stdin, not both."
    );
  });

  it("validates HTTP proxy endpoint using /v1/me", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          id: 42,
          first_name: "Test",
          last_name: "User",
        }),
    });
    activeServers.push(server);

    const user = await validateProxyConnection("prod", `http://127.0.0.1:${server.port}`);
    expect(user).toEqual({
      id: 42,
      first_name: "Test",
      last_name: "User",
    });
  });

  it("validates unix socket proxy endpoint using /v1/me", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bee-cli-login-proxy-"));
    cleanupPaths.push(dir);
    const socketPath = join(dir, "proxy.sock");

    const server = Bun.serve({
      unix: socketPath,
      fetch: () =>
        Response.json({
          id: 7,
          first_name: "Socket",
          last_name: null,
        }),
    });
    activeServers.push(server);

    const user = await validateProxyConnection("prod", socketPath);
    expect(user).toEqual({
      id: 7,
      first_name: "Socket",
      last_name: null,
    });
  });
});

// Bee's APIs are replaced by a stub of global fetch, so nothing leaves the machine.
describe("login command with an unfinished login", () => {
  const PAIRING_API = "https://auth.beeai-services.com/apps/pairing/request";
  const ME_API = "https://app-api-developer.ce.bee.amazon.dev/v1/me";
  const originalConfigDir = process.env["BEE_CONFIG_DIR"];
  const originalForceFileStore = process.env["BEE_FORCE_FILE_STORE"];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "bee-cli-login-pending-"));
    cleanupPaths.push(dir);
    process.env["BEE_CONFIG_DIR"] = dir;
    process.env["BEE_FORCE_FILE_STORE"] = "1";
  });

  afterEach(() => {
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
  });

  it("resumes an approved login, stores the token, and clears the pairing state", async () => {
    const keyPair = generateAppPairingKeyPair();
    await savePairingState("prod", {
      appId: "test-app",
      publicKey: keyPair.publicKeyBase64,
      secretKey: Buffer.from(keyPair.secretKey).toString("base64"),
      requestId: "req-123",
      pairingUrl: "https://bee.computer/connect#req-123",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    // The pairing API encrypts the token for the CLI's key: a version byte, the
    // nonce, a one-time sender public key, then the ciphertext.
    const sender = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(
      new TextEncoder().encode("test-token-0001"),
      nonce,
      keyPair.publicKeyBytes,
      sender.secretKey
    );
    const encryptedToken = Buffer.concat([
      Buffer.from([1]),
      nonce,
      sender.publicKey,
      ciphertext,
    ]).toString("base64");

    const requested: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      if (url === PAIRING_API) {
        return Response.json({
          ok: true,
          status: "completed",
          requestId: "req-123",
          result: { encryptedToken },
        });
      }
      if (url === ME_API) {
        return Response.json({ id: 42, first_name: "Test", last_name: "User" });
      }
      // A 400 is not retried, so a wrong URL fails fast instead of retrying
      // until the stub is gone and the request reaches the real host.
      return Response.json({ error: `Unexpected request to ${url}` }, { status: 400 });
    }) as typeof fetch);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await loginCommand.run([], { env: "prod", client: createDeveloperClient("prod") });
    } finally {
      logSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    expect(requested).toEqual([PAIRING_API, ME_API]);
    await expect(loadToken("prod")).resolves.toBe("test-token-0001");
    await expect(loadPairingState("prod")).resolves.toBeNull();
  });
});
