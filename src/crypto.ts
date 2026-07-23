import { base64Decode, base64Encode } from "./utils";
import { GatewayError } from "./errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importMasterKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64Decode(base64Key.trim());
  if (raw.byteLength !== 32) {
    throw new GatewayError(500, "INVALID_MASTER_KEY", "MASTER_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, masterKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importMasterKey(masterKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
  return `v1.${base64Encode(iv)}.${base64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(ciphertext: string, masterKey: string): Promise<string> {
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
  } catch {
    throw new GatewayError(500, "DECRYPT_FAILED", "Unable to decrypt stored credential");
  }
}
