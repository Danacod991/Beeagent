import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Environment } from "@/environment";
import { canonicalJson } from "./transcriptProof";

export type VerificationEventType =
  | "proof-exported"
  | "proof-verified"
  | "proof-verification-failed";

export type VerificationEvent = {
  action: VerificationEventType;
  conversationId: number | null;
  transcriptHash: string | null;
  proofHash: string;
  keyFingerprint: string | null;
  privacyMode: "full" | "hash-only" | null;
};

export type LocalVerificationLedgerEntry = VerificationEvent & {
  sequence: number;
  recordedAt: string;
  previousHash: string | null;
  entryHash: string;
};

export type LocalVerificationLedgerStatus = {
  entryCount: number;
  latestHash: string | null;
  latestRecordedAt: string | null;
};

export function defaultVerificationLedgerPath(env: Environment): string {
  const configDirectory = process.env.BEE_CONFIG_DIR ?? join(homedir(), ".bee");
  return join(configDirectory, `verification-ledger-${env}.jsonl`);
}

export async function readVerificationLedger(
  filePath: string
): Promise<LocalVerificationLedgerEntry[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Local verification ledger has invalid JSON on line ${index + 1}.`);
    }
    return parseEntry(value, index + 1);
  });
  verifyVerificationLedger(entries);
  return entries;
}

export async function appendVerificationEvent(
  filePath: string,
  event: VerificationEvent,
  recordedAt = new Date().toISOString()
): Promise<LocalVerificationLedgerEntry> {
  const existing = await readVerificationLedger(filePath);
  const existingContents = existing.length > 0
    ? await readFile(filePath, "utf8")
    : "";
  const previousHash = existing.at(-1)?.entryHash ?? null;
  const unsignedEntry: Omit<LocalVerificationLedgerEntry, "entryHash"> = {
    ...event,
    sequence: existing.length + 1,
    recordedAt,
    previousHash,
  };
  const entry: LocalVerificationLedgerEntry = {
    ...unsignedEntry,
    entryHash: sha256(canonicalJson(unsignedEntry)),
  };

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const lineSeparator = existingContents.length > 0 && !existingContents.endsWith("\n")
    ? "\n"
    : "";
  await appendFile(filePath, `${lineSeparator}${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return entry;
}

export function verifyVerificationLedger(
  entries: readonly LocalVerificationLedgerEntry[]
): LocalVerificationLedgerStatus {
  let previousHash: string | null = null;
  entries.forEach((entry, index) => {
    if (
      entry.sequence !== index + 1 ||
      entry.previousHash !== previousHash ||
      entry.entryHash !== sha256(canonicalJson(unsignedEntry(entry)))
    ) {
      throw new Error(`Local verification ledger integrity check failed at entry ${index + 1}.`);
    }
    previousHash = entry.entryHash;
  });

  return {
    entryCount: entries.length,
    latestHash: previousHash,
    latestRecordedAt: entries.at(-1)?.recordedAt ?? null,
  };
}

export function hashProofBundle(value: unknown): string {
  return sha256(canonicalJson(value));
}

function parseEntry(value: unknown, lineNumber: number): LocalVerificationLedgerEntry {
  if (!isRecord(value)) {
    throw new Error(`Local verification ledger entry ${lineNumber} is invalid.`);
  }
  const sequence = value["sequence"];
  const recordedAt = value["recordedAt"];
  const action = value["action"];
  const conversationId = value["conversationId"];
  const transcriptHash = value["transcriptHash"];
  const proofHash = value["proofHash"];
  const keyFingerprint = value["keyFingerprint"];
  const privacyMode = value["privacyMode"];
  const previousHash = value["previousHash"];
  const entryHash = value["entryHash"];

  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    typeof recordedAt !== "string" ||
    (action !== "proof-exported" &&
      action !== "proof-verified" &&
      action !== "proof-verification-failed") ||
    !(conversationId === null ||
      (typeof conversationId === "number" &&
        Number.isSafeInteger(conversationId) &&
        conversationId > 0)) ||
    !(transcriptHash === null || isSha256(transcriptHash)) ||
    !isSha256(proofHash) ||
    !(keyFingerprint === null || isSha256(keyFingerprint)) ||
    !(privacyMode === null || privacyMode === "full" || privacyMode === "hash-only") ||
    !(previousHash === null || isSha256(previousHash)) ||
    !isSha256(entryHash)
  ) {
    throw new Error(`Local verification ledger entry ${lineNumber} is invalid.`);
  }

  return {
    sequence,
    recordedAt,
    action,
    conversationId,
    transcriptHash,
    proofHash,
    keyFingerprint,
    privacyMode,
    previousHash,
    entryHash,
  };
}

function unsignedEntry(
  entry: LocalVerificationLedgerEntry
): Omit<LocalVerificationLedgerEntry, "entryHash"> {
  return {
    sequence: entry.sequence,
    recordedAt: entry.recordedAt,
    action: entry.action,
    conversationId: entry.conversationId,
    transcriptHash: entry.transcriptHash,
    proofHash: entry.proofHash,
    keyFingerprint: entry.keyFingerprint,
    privacyMode: entry.privacyMode,
    previousHash: entry.previousHash,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && "code" in error;
}
