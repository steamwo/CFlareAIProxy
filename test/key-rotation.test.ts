import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  decryptSecretDetailed,
  encryptSecret,
  reencryptSecret,
  secretNeedsRotation,
} from "../src/crypto";
import { base64Decode, base64Encode } from "../src/utils";
import { GatewayError } from "../src/errors";

function base64Key(fill: number): string {
  return Buffer.alloc(32, fill).toString("base64");
}

const CURRENT = base64Key(31);
const PREVIOUS = base64Key(32);
const UNRELATED = base64Key(33);

/** Rebuilds a v1 envelope from mutated parts without going through encryptSecret. */
function envelope(iv: Uint8Array, payload: Uint8Array): string {
  return `v1.${base64Encode(iv)}.${base64Encode(payload)}`;
}

function splitEnvelope(ciphertext: string): { iv: Uint8Array; payload: Uint8Array } {
  const parts = ciphertext.split(".");
  const ivValue = parts[1];
  const payloadValue = parts[2];
  if (!ivValue || !payloadValue) throw new Error("unexpected envelope shape");
  return { iv: base64Decode(ivValue), payload: base64Decode(payloadValue) };
}

describe("MASTER_KEY rotation", () => {
  it("encrypts and decrypts with the current key when no previous key is configured", async () => {
    const sealed = await encryptSecret("token-current", CURRENT);
    await expect(decryptSecret(sealed, CURRENT)).resolves.toBe("token-current");
    await expect(decryptSecretDetailed(sealed, CURRENT)).resolves.toEqual({
      plaintext: "token-current",
      usedPreviousKey: false,
    });
  });

  it("decrypts ciphertext sealed under the retired key via MASTER_KEY_PREVIOUS", async () => {
    const sealedWithOldKey = await encryptSecret("token-legacy", PREVIOUS);
    const result = await decryptSecretDetailed(sealedWithOldKey, CURRENT, PREVIOUS);
    expect(result).toEqual({ plaintext: "token-legacy", usedPreviousKey: true });
    await expect(decryptSecret(sealedWithOldKey, CURRENT, PREVIOUS)).resolves.toBe("token-legacy");
  });

  it("prefers the current key and does not report rotation for freshly written rows", async () => {
    const sealed = await encryptSecret("token-new", CURRENT);
    await expect(secretNeedsRotation(sealed, CURRENT, PREVIOUS)).resolves.toBe(false);
    await expect(secretNeedsRotation(await encryptSecret("token-old", PREVIOUS), CURRENT, PREVIOUS)).resolves.toBe(true);
  });

  it("always encrypts with the current key even while a previous key is configured", async () => {
    const sealed = await encryptSecret("written-now", CURRENT);
    // Decryptable by the current key alone: the previous key must never be used to write.
    await expect(decryptSecret(sealed, CURRENT)).resolves.toBe("written-now");
    await expect(decryptSecret(sealed, PREVIOUS)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("fails when neither key matches", async () => {
    const sealed = await encryptSecret("orphan", UNRELATED);
    await expect(decryptSecret(sealed, CURRENT, PREVIOUS)).rejects.toBeInstanceOf(GatewayError);
    await expect(decryptSecret(sealed, CURRENT, PREVIOUS)).rejects.toMatchObject({
      status: 500,
      code: "DECRYPT_FAILED",
    });
  });

  it("keeps behaviour identical to today when no previous key is configured", async () => {
    const sealedWithOldKey = await encryptSecret("token-legacy", PREVIOUS);
    for (const previous of [undefined, "", "   "]) {
      await expect(decryptSecret(sealedWithOldKey, CURRENT, previous)).rejects.toMatchObject({
        code: "DECRYPT_FAILED",
      });
    }
    // Configuration errors still win over any fallback logic.
    await expect(decryptSecret(sealedWithOldKey, undefined, PREVIOUS)).rejects.toMatchObject({
      status: 503,
      code: "MASTER_KEY_MISSING",
    });
    await expect(decryptSecret(sealedWithOldKey, "%%%not-base64%%%", PREVIOUS)).rejects.toMatchObject({
      status: 503,
      code: "INVALID_MASTER_KEY",
    });
  });

  it("reports an unusable MASTER_KEY_PREVIOUS under its own code", async () => {
    const sealedWithOldKey = await encryptSecret("token-legacy", PREVIOUS);
    await expect(decryptSecret(sealedWithOldKey, CURRENT, base64Key(31).slice(0, 10))).rejects.toMatchObject({
      status: 503,
      code: "INVALID_MASTER_KEY_PREVIOUS",
      type: "configuration_error",
    });
  });
});

describe("corrupt ciphertext is never treated as a rotation candidate", () => {
  let decryptSpy = vi.spyOn(crypto.subtle, "decrypt");

  beforeEach(() => {
    decryptSpy = vi.spyOn(crypto.subtle, "decrypt");
  });

  afterEach(() => {
    decryptSpy.mockRestore();
  });

  it("rejects a malformed envelope before trying any key", async () => {
    for (const broken of ["", "v2.aaaa.bbbb", "v1.onlytwo", "v1..payload"]) {
      await expect(decryptSecret(broken, CURRENT, PREVIOUS)).rejects.toMatchObject({ code: "INVALID_CIPHERTEXT" });
    }
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it("rejects a truncated payload or a wrong-sized nonce without a key fallback", async () => {
    const sealed = await encryptSecret("payload", CURRENT);
    const { iv, payload } = splitEnvelope(sealed);

    const shortTag = envelope(iv, payload.slice(0, 8));
    const shortNonce = envelope(iv.slice(0, 8), payload);
    const nonBase64 = "v1.####.$$$$";

    for (const broken of [shortTag, shortNonce, nonBase64]) {
      await expect(secretNeedsRotation(broken, CURRENT, PREVIOUS)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    }
    // Structural damage is decided without spending a subtle.decrypt on either key.
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it("reports a tampered but well-formed envelope as DECRYPT_FAILED, not as needing rotation", async () => {
    const sealed = await encryptSecret("payload", CURRENT);
    const { iv, payload } = splitEnvelope(sealed);
    const flipped = new Uint8Array(payload);
    const first = flipped[0];
    if (first === undefined) throw new Error("empty payload");
    flipped[0] = first ^ 0xff;

    await expect(secretNeedsRotation(envelope(iv, flipped), CURRENT, PREVIOUS)).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
      status: 500,
    });
    // Authentication is indistinguishable from a key mismatch, so the previous key is
    // tried; what matters is that the call fails instead of claiming a rotation is due.
    expect(decryptSpy).toHaveBeenCalledTimes(2);
  });
});

describe("lazy re-encryption primitive", () => {
  it("returns a current-key envelope for a row still on the previous key", async () => {
    const sealedWithOldKey = await encryptSecret("rotate-me", PREVIOUS);
    const rewritten = await reencryptSecret(sealedWithOldKey, CURRENT, PREVIOUS);
    expect(rewritten).not.toBeNull();
    if (rewritten === null) throw new Error("expected a rewritten envelope");
    expect(rewritten).not.toBe(sealedWithOldKey);
    await expect(decryptSecret(rewritten, CURRENT)).resolves.toBe("rotate-me");
    await expect(secretNeedsRotation(rewritten, CURRENT, PREVIOUS)).resolves.toBe(false);
  });

  it("returns null for a row that is already current so the caller skips the D1 write", async () => {
    const sealed = await encryptSecret("already-current", CURRENT);
    await expect(reencryptSecret(sealed, CURRENT, PREVIOUS)).resolves.toBeNull();
  });

  it("propagates decrypt failures instead of rewriting unreadable rows", async () => {
    const sealed = await encryptSecret("orphan", UNRELATED);
    await expect(reencryptSecret(sealed, CURRENT, PREVIOUS)).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });
});

describe("master key import memoization spans both slots", () => {
  const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
  let importKey = vi.spyOn(crypto.subtle, "importKey");

  beforeEach(() => {
    vi.resetModules();
    importKey = vi.spyOn(crypto.subtle, "importKey");
  });

  afterEach(() => {
    importKey.mockRestore();
  });

  it("imports the current and the previous key at most once each across many decrypts", async () => {
    // A fresh module instance gives a clean cache; the spy is installed on the shared
    // global subtle, so it still observes the reloaded module's imports.
    const crypt = await import("../src/crypto");
    const current = base64Key(41);
    const previous = base64Key(42);

    const sealedNew = await crypt.encryptSecret("new-a", current);
    const sealedNewToo = await crypt.encryptSecret("new-b", current);
    const sealedOld = await crypt.encryptSecret("old-a", previous);
    const sealedOldToo = await crypt.encryptSecret("old-b", previous);

    importKey.mockClear();

    await expect(crypt.decryptSecret(sealedNew, current, previous)).resolves.toBe("new-a");
    await expect(crypt.decryptSecret(sealedNewToo, current, previous)).resolves.toBe("new-b");
    await expect(crypt.decryptSecret(sealedOld, current, previous)).resolves.toBe("old-a");
    await expect(crypt.decryptSecret(sealedOldToo, current, previous)).resolves.toBe("old-b");

    // Both slots were already warmed by the encrypt calls above; six more decrypt
    // paths must not re-import either key.
    expect(importKey).not.toHaveBeenCalled();
  });

  it("shares one import per key across concurrent fallback decrypts", async () => {
    const crypt = await import("../src/crypto");
    const current = base64Key(43);
    const previous = base64Key(44);

    const sealed = await Promise.all([
      crypt.encryptSecret("a", previous),
      crypt.encryptSecret("b", previous),
      crypt.encryptSecret("c", previous),
    ]);
    importKey.mockClear();
    // Force a cold cache for both slots so the concurrent import dedup is exercised.
    vi.resetModules();
    const cold = await import("../src/crypto");

    await Promise.all(sealed.map((value) => cold.decryptSecret(value, current, previous)));

    expect(importKey).toHaveBeenCalledTimes(2);
    expect(importKey).toHaveBeenCalledWith("raw", expect.anything(), "AES-GCM", false, ["encrypt", "decrypt"]);
  });

  it("does not memoize a failed previous-key import", async () => {
    const crypt = await import("../src/crypto");
    const current = base64Key(45);
    const previous = base64Key(46);
    const sealedOld = await crypt.encryptSecret("legacy", previous);

    vi.resetModules();
    const cold = await import("../src/crypto");
    importKey.mockClear();
    // First call imports the current key, then fails on the previous one.
    importKey.mockImplementationOnce(realImportKey).mockImplementationOnce(() => Promise.reject(new Error("transient")));

    await expect(cold.decryptSecret(sealedOld, current, previous)).rejects.toMatchObject({
      code: "INVALID_MASTER_KEY_PREVIOUS",
    });

    importKey.mockImplementation(realImportKey);
    await expect(cold.decryptSecret(sealedOld, current, previous)).resolves.toBe("legacy");
  });
});
