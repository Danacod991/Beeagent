import type { Command, CommandContext } from "@/commands/types";
import { requestClientJson } from "@/client/clientApi";
import {
  createTranscriptProof,
  type TranscriptProofResult,
  verifyTranscriptProof,
} from "@/utils/transcriptProof";
import {
  appendVerificationEvent,
  defaultVerificationLedgerPath,
  hashProofBundle,
  readVerificationLedger,
  verifyVerificationLedger,
} from "@/utils/verificationLedger";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const USAGE = [
  "bee verify export <conversation-id> --private-key <ed25519-private.pem> --out <bundle.json> [--privacy-mode full|hash-only] [--ledger <path>]",
  "bee verify check <bundle.json> [--public-key <trusted-ed25519-public.pem>] [--transcript <transcriptions.json>] [--ledger <path>]",
  "bee verify status [--ledger <path>]",
  "bee verify audit [--ledger <path>]",
].join("\n");

export const verifyCommand: Command = {
  name: "verify",
  description: "Create and verify signed transcript proof bundles.",
  usage: USAGE,
  run: async (args, context) => {
    const [action, ...rest] = args;
    if (action === "export") {
      await exportProof(rest, context);
      return;
    }
    if (action === "check") {
      await checkProof(rest, context);
      return;
    }
    if (action === "status") {
      await showStatus(rest, context);
      return;
    }
    if (action === "audit" || action === "ledger") {
      await showAudit(rest, context);
      return;
    }
    throw new Error("Missing or unknown verify action. Use export, check, status, or audit.");
  },
};

async function exportProof(args: readonly string[], context: CommandContext): Promise<void> {
  const { positional, flags } = parseArgs(args, [
    "--private-key",
    "--out",
    "--privacy-mode",
    "--ledger",
  ]);
  if (positional.length !== 1) {
    throw new Error("Provide exactly one conversation id.");
  }
  const id = Number(positional[0]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Conversation id must be a positive integer.");
  }
  const privateKeyPath = requiredFlag(flags, "--private-key");
  const outputPath = requiredFlag(flags, "--out");
  const privacyMode = parsePrivacyMode(flags.get("--privacy-mode"));
  const ledgerPath = flags.get("--ledger") ?? defaultVerificationLedgerPath(context.env);
  const resolvedOutputPath = resolve(outputPath);
  const resolvedLedgerPath = resolve(ledgerPath);
  const outputAndLedgerMatch = process.platform === "win32"
    ? resolvedOutputPath.toLowerCase() === resolvedLedgerPath.toLowerCase()
    : resolvedOutputPath === resolvedLedgerPath;
  if (outputAndLedgerMatch) {
    throw new Error("Proof output path must be different from the local ledger path.");
  }
  await readVerificationLedger(ledgerPath);
  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const sourceResponse = await requestClientJson(context, `/v1/conversations/${id}`, {
    method: "GET",
  });
  const bundle = createTranscriptProof(sourceResponse, id, privateKeyPem, { privacyMode });

  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await appendVerificationEvent(ledgerPath, {
    action: "proof-exported",
    conversationId: bundle.proof.conversationId,
    transcriptHash: bundle.proof.transcriptHash,
    proofHash: hashProofBundle(bundle),
    keyFingerprint: bundle.keyFingerprint,
    privacyMode,
  });
  console.log(`Signed transcript proof exported to ${outputPath}`);
  console.log(`Key fingerprint: ${bundle.keyFingerprint}`);
  console.log(`Proof mode: ${privacyMode}`);
  console.log(`Local audit ledger: ${ledgerPath}`);
  console.log("The generated time is local and is not a trusted timestamp.");
}

async function checkProof(args: readonly string[], context: CommandContext): Promise<void> {
  const { positional, flags } = parseArgs(args, ["--public-key", "--transcript", "--ledger"]);
  if (positional.length !== 1) {
    throw new Error("Provide exactly one proof bundle path.");
  }
  const bundleText = await readFile(positional[0]!, "utf8");
  const bundle = parseJson(bundleText);
  const trustedKeyPath = flags.get("--public-key");
  const trustedKey = trustedKeyPath === undefined
    ? undefined
    : await readFile(trustedKeyPath, "utf8");
  const transcriptionsPath = flags.get("--transcript");
  const transcriptions = transcriptionsPath === undefined
    ? undefined
    : parseTranscriptions(await readFile(transcriptionsPath, "utf8"));
  const ledgerPath = flags.get("--ledger") ?? defaultVerificationLedgerPath(context.env);
  let result: TranscriptProofResult;
  try {
    result = verifyTranscriptProof(bundle, trustedKey, transcriptions);
  } catch (error) {
    await appendVerificationEvent(ledgerPath, {
      action: "proof-verification-failed",
      conversationId: null,
      transcriptHash: null,
      proofHash: hashProofBundle(bundle),
      keyFingerprint: null,
      privacyMode: null,
    });
    throw error;
  }
  await appendVerificationEvent(ledgerPath, {
    action: "proof-verified",
    conversationId: result.conversationId,
    transcriptHash: result.transcriptHash,
    proofHash: hashProofBundle(bundle),
    keyFingerprint: result.keyFingerprint,
    privacyMode: result.privacyMode,
  });

  if (result.privacyMode === "hash-only" && transcriptions === undefined) {
    console.log("PASS: proof signature is valid; transcript content was not checked.");
  } else {
    console.log("PASS: transcript hash and Ed25519 signature are valid.");
  }
  console.log(`Conversation: ${result.conversationId}`);
  console.log(`Generated at (local, untrusted): ${result.generatedAt}`);
  console.log(`Transcript SHA-256: ${result.transcriptHash}`);
  console.log(`Key fingerprint: ${result.keyFingerprint}`);
  console.log(`Proof mode: ${result.privacyMode}`);
  if (result.suppliedTranscriptMatched === true) {
    console.log("Supplied transcript: hash matched.");
  }
  if (result.privacyMode === "hash-only" && transcriptions === undefined) {
    console.log("Transcript content was not included; the signature authenticates the hash only.");
  }
  if (trustedKey === undefined) {
    console.log("Warning: embedded public key is self-asserted; use --public-key to check a separately trusted key.");
  } else {
    console.log("Trusted public key: matched.");
  }
  console.log(`Local audit ledger: ${ledgerPath}`);
  console.log("This verifies the exported snapshot, not Bee authorship or transcription accuracy.");
}

async function showStatus(args: readonly string[], context: CommandContext): Promise<void> {
  const { positional, flags } = parseArgs(args, ["--ledger"]);
  if (positional.length > 0) {
    throw new Error("verify status does not accept positional arguments.");
  }
  const ledgerPath = flags.get("--ledger") ?? defaultVerificationLedgerPath(context.env);
  const entries = await readVerificationLedger(ledgerPath);
  const status = verifyVerificationLedger(entries);
  const exports = entries.filter((entry) => entry.action === "proof-exported").length;
  const verified = entries.filter((entry) => entry.action === "proof-verified").length;
  const failed = entries.filter((entry) => entry.action === "proof-verification-failed").length;

  console.log("BEE local transcript verification");
  console.log(`Ledger integrity: VALID (${status.entryCount} entries)`);
  console.log(`Proofs exported: ${exports}`);
  console.log(`Proofs verified: ${verified}`);
  console.log(`Verification failures: ${failed}`);
  console.log(`Latest local event: ${status.latestRecordedAt ?? "none"}`);
  console.log(`Ledger: ${ledgerPath}`);
  console.log("Local hash chain only; not a blockchain or trusted timestamp.");
}

async function showAudit(args: readonly string[], context: CommandContext): Promise<void> {
  const { positional, flags } = parseArgs(args, ["--ledger"]);
  if (positional.length > 0) {
    throw new Error("verify audit does not accept positional arguments.");
  }
  const ledgerPath = flags.get("--ledger") ?? defaultVerificationLedgerPath(context.env);
  const entries = await readVerificationLedger(ledgerPath);
  const status = verifyVerificationLedger(entries);

  console.log(`Local verification audit (${status.entryCount} entries)`);
  if (entries.length === 0) {
    console.log("(no local verification events)");
    return;
  }
  for (const entry of entries) {
    console.log(
      `${entry.sequence}. ${entry.recordedAt} ${entry.action} ` +
      `conversation=${entry.conversationId ?? "unknown"} ` +
      `proof=${entry.proofHash.slice(0, 16)}...`
    );
  }
  console.log(`Latest entry hash: ${status.latestHash}`);
  console.log("This local hash chain detects edits to retained entries; it cannot prove that its tail was not removed.");
}

function parseTranscriptions(value: string): unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Transcript file must contain a JSON array of Bee transcriptions.");
  }
  return parsed;
}

function parsePrivacyMode(value: string | undefined): "full" | "hash-only" {
  if (value === undefined || value === "full") {
    return "full";
  }
  if (value === "hash-only") {
    return "hash-only";
  }
  throw new Error("--privacy-mode must be full or hash-only.");
}

function parseArgs(
  args: readonly string[],
  supportedFlags: readonly string[]
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!supportedFlags.includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (flags.has(arg)) {
      throw new Error(`${arg} may only be specified once.`);
    }
    const value = args[index + 1];
    if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    flags.set(arg, value);
    index += 1;
  }
  return { positional, flags };
}

function requiredFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Proof bundle is not valid JSON.");
  }
}
