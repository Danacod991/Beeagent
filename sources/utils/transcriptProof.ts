import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export const TRANSCRIPT_PROOF_FORMAT = "bee-transcript-proof-v1";

export type TranscriptProofPayload = {
  format: typeof TRANSCRIPT_PROOF_FORMAT;
  generatedAt: string;
  conversationId: number;
  transcriptHash: string;
  privacyMode?: "full" | "hash-only";
  sourceResponse?: unknown;
};

export type TranscriptProofBundle = {
  format: typeof TRANSCRIPT_PROOF_FORMAT;
  proof: TranscriptProofPayload;
  publicKey: string;
  keyFingerprint: string;
  signature: string;
};

export type TranscriptProofResult = {
  conversationId: number;
  generatedAt: string;
  transcriptHash: string;
  keyFingerprint: string;
  privacyMode: "full" | "hash-only";
  suppliedTranscriptMatched?: boolean;
};

export type TranscriptProofOptions = {
  privacyMode?: "full" | "hash-only";
  generatedAt?: string;
};

export function createTranscriptProof(
  sourceResponse: unknown,
  conversationId: number,
  privateKeyPem: string,
  options: TranscriptProofOptions = {}
): TranscriptProofBundle {
  const conversation = extractConversation(sourceResponse, conversationId);
  const privateKey = parseEd25519Key(privateKeyPem, "private");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privacyMode = options.privacyMode ?? "full";
  const transcriptHash = hashTranscript(conversation.transcriptions);

  const proof: TranscriptProofPayload = {
    format: TRANSCRIPT_PROOF_FORMAT,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    conversationId,
    transcriptHash,
    privacyMode,
    ...(privacyMode === "full" ? { sourceResponse } : {}),
  };

  return {
    format: TRANSCRIPT_PROOF_FORMAT,
    proof,
    publicKey: publicKeyPem,
    keyFingerprint: fingerprint(publicKey),
    signature: sign(null, Buffer.from(canonicalJson(proof)), privateKey).toString("base64"),
  };
}

export function verifyTranscriptProof(
  value: unknown,
  trustedPublicKeyPem?: string,
  suppliedTranscriptions?: unknown[]
): TranscriptProofResult {
  const bundle = parseBundle(value);
  const publicKey = parseEd25519Key(bundle.publicKey, "public");
  const actualFingerprint = fingerprint(publicKey);
  if (actualFingerprint !== bundle.keyFingerprint) {
    throw new Error("Proof public-key fingerprint does not match.");
  }
  if (trustedPublicKeyPem !== undefined) {
    const trustedKey = parseEd25519Key(trustedPublicKeyPem, "public");
    if (fingerprint(trustedKey) !== actualFingerprint) {
      throw new Error("Proof was not signed by the supplied trusted public key.");
    }
  }

  const privacyMode = bundle.proof.privacyMode ?? "full";
  let suppliedTranscriptMatched: boolean | undefined;
  if (privacyMode === "full") {
    const conversation = extractConversation(bundle.proof.sourceResponse, bundle.proof.conversationId);
    const actualTranscriptHash = hashTranscript(conversation.transcriptions);
    if (actualTranscriptHash !== bundle.proof.transcriptHash) {
      throw new Error("Transcript hash does not match the proof.");
    }
  }
  if (suppliedTranscriptions !== undefined) {
    suppliedTranscriptMatched =
      hashTranscript(suppliedTranscriptions) === bundle.proof.transcriptHash;
    if (!suppliedTranscriptMatched) {
      throw new Error("Supplied transcript hash does not match the proof.");
    }
  }

  const signature = Buffer.from(bundle.signature, "base64");
  if (
    signature.length !== 64 ||
    !verify(null, Buffer.from(canonicalJson(bundle.proof)), publicKey, signature)
  ) {
    throw new Error("Proof signature is invalid.");
  }

  return {
    conversationId: bundle.proof.conversationId,
    generatedAt: bundle.proof.generatedAt,
    transcriptHash: bundle.proof.transcriptHash,
    keyFingerprint: actualFingerprint,
    privacyMode,
    ...(suppliedTranscriptMatched !== undefined ? { suppliedTranscriptMatched } : {}),
  };
}

export function hashTranscript(transcriptions: unknown[]): string {
  return sha256(canonicalJson(transcriptions));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Proof data contains an unsupported value.");
    }
    return serialized;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Proof data contains a non-finite number.");
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Proof data contains an unsupported value.");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Proof data contains an unsupported value.");
}

function parseBundle(value: unknown): TranscriptProofBundle {
  if (
    !isRecord(value) ||
    value["format"] !== TRANSCRIPT_PROOF_FORMAT ||
    !isRecord(value["proof"])
  ) {
    throw new Error("Invalid transcript proof bundle.");
  }
  const proof = value["proof"];
  const format = proof["format"];
  const generatedAt = proof["generatedAt"];
  const conversationId = proof["conversationId"];
  const transcriptHash = proof["transcriptHash"];
  const privacyMode = proof["privacyMode"];
  const hasSourceResponse = Object.hasOwn(proof, "sourceResponse");
  if (
    format !== TRANSCRIPT_PROOF_FORMAT ||
    typeof generatedAt !== "string" ||
    typeof conversationId !== "number" ||
    !Number.isSafeInteger(conversationId) ||
    conversationId <= 0 ||
    typeof transcriptHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(transcriptHash) ||
    (privacyMode !== undefined && privacyMode !== "full" && privacyMode !== "hash-only") ||
    (privacyMode === "hash-only" && hasSourceResponse) ||
    (privacyMode !== "hash-only" && !hasSourceResponse) ||
    typeof value["publicKey"] !== "string" ||
    typeof value["keyFingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["keyFingerprint"]) ||
    typeof value["signature"] !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value["signature"])
  ) {
    throw new Error("Invalid transcript proof bundle.");
  }

  return {
    format: TRANSCRIPT_PROOF_FORMAT,
    proof: {
      format: TRANSCRIPT_PROOF_FORMAT,
      generatedAt,
      conversationId,
      transcriptHash,
      ...(privacyMode !== undefined ? { privacyMode } : {}),
      ...(hasSourceResponse ? { sourceResponse: proof["sourceResponse"] } : {}),
    },
    publicKey: value["publicKey"],
    keyFingerprint: value["keyFingerprint"],
    signature: value["signature"],
  };
}

function extractConversation(
  sourceResponse: unknown,
  expectedId: number
): { transcriptions: unknown[] } {
  if (!isRecord(sourceResponse) || !isRecord(sourceResponse["conversation"])) {
    throw new Error("Bee returned an invalid conversation response.");
  }
  const conversation = sourceResponse["conversation"];
  if (
    conversation["id"] !== expectedId ||
    !Array.isArray(conversation["transcriptions"])
  ) {
    throw new Error("Bee response did not contain the requested conversation transcript.");
  }
  return { transcriptions: conversation["transcriptions"] };
}

function parseEd25519Key(pem: string, kind: "private" | "public"): KeyObject {
  let key: KeyObject;
  try {
    key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  } catch {
    throw new Error(`Invalid ${kind} key. Expected an Ed25519 PEM-encoded key.`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Unsupported ${kind} key type. Expected Ed25519.`);
  }
  return key;
}

function fingerprint(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  const der = publicKey.export({ type: "spki", format: "der" });
  return sha256(der);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
