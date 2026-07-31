import { base64Decode, base64Encode } from "./utils";
import { GatewayError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** AES-GCM nonce length written by encryptSecret. */
const IV_BYTES = 12;
/** AES-GCM authentication tag appended to every ciphertext. */
const GCM_TAG_BYTES = 16;

type MasterKeySlot = "MASTER_KEY" | "MASTER_KEY_PREVIOUS";
type MasterKeyErrorCode = "MASTER_KEY_MISSING" | "INVALID_MASTER_KEY" | "INVALID_MASTER_KEY_PREVIOUS";

function masterKeyError(code: MasterKeyErrorCode, message: string): GatewayError {
  return new GatewayError(503, code, message, "configuration_error");
}

/** Raised inside the memoized import so the slot-specific message can be attached by the caller. */
class MasterKeyImportFailure extends Error {
  constructor(readonly reason: "encoding" | "import") {
    super(`master key ${reason} failure`);
  }
}

function slotImportError(slot: MasterKeySlot, reason: "encoding" | "import"): GatewayError {
  const code: MasterKeyErrorCode = slot === "MASTER_KEY" ? "INVALID_MASTER_KEY" : "INVALID_MASTER_KEY_PREVIOUS";
  const message =
    reason === "encoding"
      ? `${slot} is invalid. It must be a base64-encoded 32-byte key.`
      : `${slot} could not be imported. Generate a new base64-encoded 32-byte key and redeploy.`;
  return masterKeyError(code, message);
}

// An AES-GCM CryptoKey is immutable and MASTER_KEY is fixed for the lifetime of a
// deployment, so the import is memoized per isolate. A single inference request
// decrypts 4-6 secrets (credential secret + refresh token + account/provider/system
// proxy URLs); without this each one paid for its own subtle.importKey.
// Keyed by the raw key material rather than by env slot, so MASTER_KEY and
// MASTER_KEY_PREVIOUS each get their own entry and both stay memoized during a rotation.
const masterKeyCache = new Map<string, Promise<CryptoKey>>();
const MASTER_KEY_CACHE_LIMIT = 4;

async function importRawMasterKey(normalized: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64Decode(normalized);
  } catch {
    throw new MasterKeyImportFailure("encoding");
  }

  if (raw.byteLength !== 32) {
    throw new MasterKeyImportFailure("encoding");
  }

  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw new MasterKeyImportFailure("import");
  }
}

async function importMasterKey(base64Key: string | undefined, slot: MasterKeySlot): Promise<CryptoKey> {
  const normalized = typeof base64Key === "string" ? base64Key.trim() : "";
  if (!normalized) {
    throw masterKeyError(
      "MASTER_KEY_MISSING",
      "MASTER_KEY is not configured. Set it to a base64-encoded 32-byte Worker secret and redeploy.",
    );
  }
  const cached = masterKeyCache.get(normalized);
  if (cached) return withSlotError(cached, slot);
  // Cache the promise, not the resolved key, so concurrent callers share one import.
  // Rejections are evicted so a transient failure is never memoized.
  const pending = importRawMasterKey(normalized);
  pending.catch(() => {
    if (masterKeyCache.get(normalized) === pending) masterKeyCache.delete(normalized);
  });
  if (masterKeyCache.size >= MASTER_KEY_CACHE_LIMIT) masterKeyCache.clear();
  masterKeyCache.set(normalized, pending);
  return withSlotError(pending, slot);
}

async function withSlotError(pending: Promise<CryptoKey>, slot: MasterKeySlot): Promise<CryptoKey> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof MasterKeyImportFailure) throw slotImportError(slot, error.reason);
    throw error;
  }
}

export async function encryptSecret(plaintext: string, masterKey: string | undefined): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importMasterKey(masterKey, "MASTER_KEY");
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `v1.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

interface Envelope {
  iv: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
}

function decryptFailed(): GatewayError {
  return new GatewayError(500, "DECRYPT_FAILED", "Unable to decrypt stored credential");
}

/**
 * Rejects everything that is structurally broken before any key is tried. A damaged
 * envelope must never be retried against MASTER_KEY_PREVIOUS: retrying cannot succeed
 * and would let corruption masquerade as "needs rotation".
 */
function parseEnvelope(ciphertext: string): Envelope {
  const [version, ivValue, payloadValue] = ciphertext.split(".");
  if (version !== "v1" || !ivValue || !payloadValue) {
    throw new GatewayError(500, "INVALID_CIPHERTEXT", "Stored credential ciphertext is invalid");
  }
  let iv: Uint8Array<ArrayBuffer>;
  let payload: Uint8Array<ArrayBuffer>;
  try {
    iv = base64Decode(ivValue);
    payload = base64Decode(payloadValue);
  } catch {
    throw decryptFailed();
  }
  // v1 always writes a 12-byte nonce and appends a 16-byte tag, so anything else is
  // truncation or tampering rather than a key mismatch.
  if (iv.byteLength !== IV_BYTES || payload.byteLength < GCM_TAG_BYTES) {
    throw decryptFailed();
  }
  return { iv, payload };
}

/** Returns null on authentication failure, which AES-GCM reports identically for a wrong key and a tampered tag. */
async function tryDecrypt(key: CryptoKey, envelope: Envelope): Promise<string | null> {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv }, key, envelope.payload);
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

export interface DecryptedSecret {
  plaintext: string;
  /** True when MASTER_KEY could not open the envelope and MASTER_KEY_PREVIOUS did. */
  usedPreviousKey: boolean;
}

/**
 * Decrypts with MASTER_KEY, falling back to MASTER_KEY_PREVIOUS during a key rotation.
 * The flag lets an admin-triggered batch job re-encrypt the row; callers on the request
 * hot path must ignore it, because rewriting there would turn every read into a D1 write.
 */
export async function decryptSecretDetailed(
  ciphertext: string,
  masterKey: string | undefined,
  previousMasterKey?: string | undefined,
): Promise<DecryptedSecret> {
  const envelope = parseEnvelope(ciphertext);
  // A missing or malformed MASTER_KEY stays a configuration error even when a previous
  // key is present: silently running on the retired key would hide a broken deployment.
  const currentKey = await importMasterKey(masterKey, "MASTER_KEY");

  const current = await tryDecrypt(currentKey, envelope);
  if (current !== null) return { plaintext: current, usedPreviousKey: false };

  const normalizedPrevious = typeof previousMasterKey === "string" ? previousMasterKey.trim() : "";
  if (!normalizedPrevious) throw decryptFailed();

  const previousKey = await importMasterKey(normalizedPrevious, "MASTER_KEY_PREVIOUS");
  const previous = await tryDecrypt(previousKey, envelope);
  if (previous !== null) return { plaintext: previous, usedPreviousKey: true };
  throw decryptFailed();
}

export async function decryptSecret(
  ciphertext: string,
  masterKey: string | undefined,
  previousMasterKey?: string | undefined,
): Promise<string> {
  const decrypted = await decryptSecretDetailed(ciphertext, masterKey, previousMasterKey);
  return decrypted.plaintext;
}

/**
 * True when the row is still sealed under MASTER_KEY_PREVIOUS. Throws the same errors as
 * decryptSecret, so a corrupt row surfaces as DECRYPT_FAILED instead of a rotation candidate.
 */
export async function secretNeedsRotation(
  ciphertext: string,
  masterKey: string | undefined,
  previousMasterKey?: string | undefined,
): Promise<boolean> {
  const decrypted = await decryptSecretDetailed(ciphertext, masterKey, previousMasterKey);
  return decrypted.usedPreviousKey;
}

/**
 * Batch-rotation primitive: returns a fresh MASTER_KEY envelope for a row still on the
 * previous key, or null when the row is already current and must not be rewritten.
 * Never touches D1 — the caller decides when to pay for the write.
 */
export async function reencryptSecret(
  ciphertext: string,
  masterKey: string | undefined,
  previousMasterKey?: string | undefined,
): Promise<string | null> {
  const decrypted = await decryptSecretDetailed(ciphertext, masterKey, previousMasterKey);
  if (!decrypted.usedPreviousKey) return null;
  return encryptSecret(decrypted.plaintext, masterKey);
}
