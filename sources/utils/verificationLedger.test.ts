import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendVerificationEvent,
  readVerificationLedger,
  verifyVerificationLedger,
} from "./verificationLedger";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0, directories.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bee-ledger-"));
  directories.push(directory);
  return directory;
}

const firstEvent = {
  action: "proof-exported" as const,
  conversationId: 42,
  transcriptHash: "a".repeat(64),
  proofHash: "b".repeat(64),
  keyFingerprint: "c".repeat(64),
  privacyMode: "full" as const,
};

describe("local verification ledger", () => {
  it("appends events with a verifiable hash chain", async () => {
    const filePath = join(createDirectory(), "ledger.jsonl");
    const first = await appendVerificationEvent(filePath, firstEvent, "2026-10-23T00:00:00.000Z");
    writeFileSync(filePath, readFileSync(filePath, "utf8").trimEnd(), "utf8");
    const second = await appendVerificationEvent(
      filePath,
      { ...firstEvent, action: "proof-verified" },
      "2026-10-23T00:01:00.000Z"
    );

    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.entryHash);
    const entries = await readVerificationLedger(filePath);
    expect(verifyVerificationLedger(entries)).toMatchObject({
      entryCount: 2,
      latestHash: second.entryHash,
    });
  });

  it("rejects a modified entry", async () => {
    const filePath = join(createDirectory(), "ledger.jsonl");
    await appendVerificationEvent(filePath, firstEvent, "2026-10-23T00:00:00.000Z");
    const entry = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    entry.action = "proof-verified";
    writeFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    await expect(readVerificationLedger(filePath)).rejects.toThrow(
      "integrity check failed at entry 1"
    );
  });

  it("rejects malformed ledger lines", async () => {
    const filePath = join(createDirectory(), "ledger.jsonl");
    writeFileSync(filePath, "{bad json}\n", "utf8");

    await expect(readVerificationLedger(filePath)).rejects.toThrow(
      "invalid JSON on line 1"
    );
  });
});
