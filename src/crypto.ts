import { base64Decode, base64Encode } from "./utils";
import { GatewayError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function masterKeyError(code: "MASTER_KEY_MISSING" | "INVALID_MASTER_KEY", message: string): GatewayError {
  return new GatewayError(503, code, message, "configuration_error");
}

async function importMasterKey(base64Key: string | undefined): Promise<CryptoKey> {
  const normalized = typeof base64Key === "string" ? base64Key.trim() : "";
  if (!normalized) {
    throw masterKeyError(
      "MASTER_KEY_MISSING",
      "MASTER_KEY is not configured. Set it to a base64-encoded 32-byte Worker secret and redeploy.",
    );
  }

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64Decode(normalized);
  } catch {
    throw masterKeyError(
      "INVALID_MASTER_KEY",
      "MASTER_KEY is invalid. It must be a base64-encoded 32-byte key.",
    );
  }

  if (raw.byteLength !== 32) {
    throw masterKeyError(
      "INVALID_MASTER_KEY",
      "MASTER_KEY is invalid. It must be a base64-encoded 32-byte key.",
    );
  }

  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw masterKeyError(
      "INVALID_MASTER_KEY",
      "MASTER_KEY could not be imported. Generate a new base64-encoded 32-byte key and redeploy.",
    );
  }
}

export async function encryptSecret(plaintext: string, masterKey: string | undefined): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importMasterKey(masterKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `v1.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(ciphertext: string, masterKey: string | undefined): Promise<string> {
  const [version, ivValue, payloadValue] = ciphertext.split(".");
  if (version !== "v1" || !ivValue || !payloadValue) {
    throw new GatewayError(500, "INVALID_CIPHERTEXT", "Stored credential ciphertext is invalid");
  }
  try {
    const key = await importMasterKey(masterKey);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64Decode(ivValue) },
      key,
      base64Decode(payloadValue),
    );
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(500, "DECRYPT_FAILED", "Unable to decrypt stored credential");
  }
}
