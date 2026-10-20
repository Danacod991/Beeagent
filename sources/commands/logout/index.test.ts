import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "@/commands/types";
import {
  loadPairingState,
  loadProxyConfig,
  loadToken,
  savePairingState,
  saveProxyConfig,
  saveToken,
} from "@/secureStore";
import { logoutCommand } from "./index";

describe("logout command", () => {
  const originalConfigDir = process.env["BEE_CONFIG_DIR"];
  const originalForceFileStore = process.env["BEE_FORCE_FILE_STORE"];
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bee-cli-logout-"));
    process.env["BEE_CONFIG_DIR"] = tempDir;
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
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears both token and proxy config", async () => {
    await saveToken("prod", "test-token");
    await saveProxyConfig("prod", { address: "http://127.0.0.1:8787" });

    const context: CommandContext = {
      env: "prod",
      client: {
        env: "prod",
        baseUrl: "http://127.0.0.1",
        isProxy: false,
        fetch: async () => new Response("ok"),
      },
    };

    await logoutCommand.run([], context);

    await expect(loadToken("prod")).resolves.toBeNull();
    await expect(loadProxyConfig("prod")).resolves.toBeNull();
  });

  it("drops an unfinished login so 'bee status' cannot finish it later", async () => {
    await savePairingState("prod", {
      appId: "test-app",
      publicKey: "test-public-key",
      secretKey: "test-secret-key",
      requestId: "req-123",
      pairingUrl: "https://bee.computer/connect#req-123",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const context: CommandContext = {
      env: "prod",
      client: {
        env: "prod",
        baseUrl: "http://127.0.0.1",
        isProxy: false,
        fetch: async () => new Response("ok"),
      },
    };

    await logoutCommand.run([], context);

    await expect(loadPairingState("prod")).resolves.toBeNull();
  });
});
