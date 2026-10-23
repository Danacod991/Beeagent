import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "@/commands/types";
import { createProxyClient } from "@/client";
import { verifyCommand } from "./index";

type BunServer = ReturnType<typeof Bun.serve>;

const activeServers: BunServer[] = [];
const activeDirectories: string[] = [];

afterEach(() => {
  for (const server of activeServers.splice(0, activeServers.length)) {
    server.stop(true);
  }
  for (const directory of activeDirectories.splice(0, activeDirectories.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("verify command", () => {
  it("exports a Bee conversation and verifies the signed evidence bundle", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const directory = mkdtempSync(join(tmpdir(), "bee-verify-"));
    activeDirectories.push(directory);
    const privateKeyPath = join(directory, "private.pem");
    const publicKeyPath = join(directory, "public.pem");
    const bundlePath = join(directory, "proof.json");
    const ledgerPath = join(directory, "ledger.jsonl");
    writeFileSync(privateKeyPath, privateKey, "utf8");
    writeFileSync(publicKeyPath, publicKey, "utf8");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        expect(new URL(request.url).pathname).toBe("/v1/conversations/42");
        return Response.json({
          conversation: {
            id: 42,
            transcriptions: [{ utterances: [{ text: "Verified transcript." }] }],
          },
        });
      },
    });
    activeServers.push(server);
    const context: CommandContext = {
      env: "prod",
      client: createProxyClient("prod", { address: `http://127.0.0.1:${server.port}` }),
    };

    await verifyCommand.run(
      ["export", "42", "--private-key", privateKeyPath, "--out", bundlePath, "--ledger", ledgerPath],
      context
    );
    await verifyCommand.run(
      ["check", bundlePath, "--public-key", publicKeyPath, "--ledger", ledgerPath],
      context
    );

    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      proof: { sourceResponse: { conversation: { transcriptions: Array<{ utterances: Array<{ text: string }> }> } } };
    };
    expect(bundle.proof.sourceResponse.conversation.transcriptions[0]!.utterances[0]!.text)
      .toBe("Verified transcript.");
  });

  it("exports a hash-only privacy proof and checks a supplied transcript", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateKeyPath = join(createTrackedDirectory(), "private.pem");
    const publicKeyPath = join(createTrackedDirectory(), "public.pem");
    const bundlePath = join(createTrackedDirectory(), "private-proof.json");
    const transcriptPath = join(createTrackedDirectory(), "transcriptions.json");
    const ledgerPath = join(createTrackedDirectory(), "ledger.jsonl");
    writeFileSync(
      privateKeyPath,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "utf8"
    );
    writeFileSync(
      publicKeyPath,
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "utf8"
    );
    const transcriptions = [{ utterances: [{ text: "Private transcript." }] }];
    writeFileSync(transcriptPath, JSON.stringify(transcriptions), "utf8");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ conversation: { id: 42, transcriptions } }),
    });
    activeServers.push(server);
    const context: CommandContext = {
      env: "prod",
      client: createProxyClient("prod", { address: `http://127.0.0.1:${server.port}` }),
    };

    await verifyCommand.run(
      [
        "export",
        "42",
        "--private-key",
        privateKeyPath,
        "--out",
        bundlePath,
        "--privacy-mode",
        "hash-only",
        "--ledger",
        ledgerPath,
      ],
      context
    );
    await verifyCommand.run(
      [
        "check",
        bundlePath,
        "--public-key",
        publicKeyPath,
        "--transcript",
        transcriptPath,
        "--ledger",
        ledgerPath,
      ],
      context
    );

    const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      proof: { privacyMode: string; sourceResponse?: unknown };
    };
    expect(bundle.proof.privacyMode).toBe("hash-only");
    expect(bundle.proof.sourceResponse).toBeUndefined();
  });

  it("does not overwrite an existing proof export", async () => {
    const pair = generateKeyPairSync("ed25519");
    const directory = mkdtempSync(join(tmpdir(), "bee-verify-"));
    activeDirectories.push(directory);
    const privateKeyPath = join(directory, "private.pem");
    const bundlePath = join(directory, "proof.json");
    const ledgerPath = join(directory, "ledger.jsonl");
    writeFileSync(
      privateKeyPath,
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "utf8"
    );
    writeFileSync(bundlePath, "keep", "utf8");

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({
        conversation: { id: 42, transcriptions: [] },
      }),
    });
    activeServers.push(server);
    const context: CommandContext = {
      env: "prod",
      client: createProxyClient("prod", { address: `http://127.0.0.1:${server.port}` }),
    };

    await expect(
      verifyCommand.run(
        ["export", "42", "--private-key", privateKeyPath, "--out", bundlePath, "--ledger", ledgerPath],
        context
      )
    ).rejects.toThrow();
    expect(readFileSync(bundlePath, "utf8")).toBe("keep");
  });
});

function createTrackedDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bee-verify-"));
  activeDirectories.push(directory);
  return directory;
}
