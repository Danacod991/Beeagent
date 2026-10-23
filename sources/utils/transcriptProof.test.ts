import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  canonicalJson,
  createTranscriptProof,
  verifyTranscriptProof,
} from "./transcriptProof";

function ed25519Keys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function conversationResponse(text = "Let's meet tomorrow."): unknown {
  return {
    timezone: "UTC",
    conversation: {
      id: 42,
      start_time: 1_800_000_000_000,
      transcriptions: [{
        id: 5,
        utterances: [{ id: 8, text, speaker: "SPEAKER_1" }],
      }],
    },
  };
}

describe("transcript proof", () => {
  it("creates and verifies a proof against a separately trusted key", () => {
    const keys = ed25519Keys();
    const bundle = createTranscriptProof(
      conversationResponse(),
      42,
      keys.privateKey,
      { generatedAt: "2026-10-23T00:00:00.000Z" }
    );

    const result = verifyTranscriptProof(bundle, keys.publicKey);
    expect(result.conversationId).toBe(42);
    expect(result.generatedAt).toBe("2026-10-23T00:00:00.000Z");
    expect(result.transcriptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects transcript modifications", () => {
    const keys = ed25519Keys();
    const bundle = createTranscriptProof(conversationResponse(), 42, keys.privateKey);
    const tampered = structuredClone(bundle);
    const response = tampered.proof.sourceResponse as {
      conversation: { transcriptions: Array<{ utterances: Array<{ text: string }> }> };
    };
    response.conversation.transcriptions[0]!.utterances[0]!.text = "Modified.";

    expect(() => verifyTranscriptProof(tampered)).toThrow("Transcript hash does not match");
  });

  it("rejects modifications to signed conversation metadata", () => {
    const keys = ed25519Keys();
    const bundle = createTranscriptProof(conversationResponse(), 42, keys.privateKey);
    const tampered = structuredClone(bundle);
    const response = tampered.proof.sourceResponse as { timezone: string };
    response.timezone = "Pacific/Auckland";

    expect(() => verifyTranscriptProof(tampered)).toThrow("Proof signature is invalid");
  });

  it("rejects a proof signed by a key other than the supplied trusted key", () => {
    const signingKeys = ed25519Keys();
    const otherKeys = ed25519Keys();
    const bundle = createTranscriptProof(conversationResponse(), 42, signingKeys.privateKey);

    expect(() => verifyTranscriptProof(bundle, otherKeys.publicKey)).toThrow(
      "supplied trusted public key"
    );
  });

  it("rejects a source response for a different conversation", () => {
    const keys = ed25519Keys();

    expect(() => createTranscriptProof(conversationResponse(), 43, keys.privateKey)).toThrow(
      "did not contain the requested conversation transcript"
    );
  });

  it("creates a hash-only proof without embedding transcript data", () => {
    const keys = ed25519Keys();
    const bundle = createTranscriptProof(conversationResponse(), 42, keys.privateKey, {
      privacyMode: "hash-only",
    });

    expect(bundle.proof.sourceResponse).toBeUndefined();
    expect(verifyTranscriptProof(bundle, keys.publicKey).privacyMode).toBe("hash-only");
    expect(
      verifyTranscriptProof(
        bundle,
        keys.publicKey,
        [{ id: 5, utterances: [{ id: 8, text: "Let's meet tomorrow.", speaker: "SPEAKER_1" }] }]
      ).suppliedTranscriptMatched
    ).toBe(true);
  });

  it("rejects transcript data that does not match a hash-only proof", () => {
    const keys = ed25519Keys();
    const bundle = createTranscriptProof(conversationResponse(), 42, keys.privateKey, {
      privacyMode: "hash-only",
    });

    expect(() =>
      verifyTranscriptProof(bundle, keys.publicKey, [{ utterances: [{ text: "changed" }] }])
    ).toThrow("Supplied transcript hash does not match");
  });

  it("canonicalizes object keys without reordering arrays", () => {
    expect(canonicalJson({ z: 1, a: [{ y: true, b: null }] })).toBe(
      '{"a":[{"b":null,"y":true}],"z":1}'
    );
  });
});
