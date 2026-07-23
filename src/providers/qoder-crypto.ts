import { base64Encode } from "../utils";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const QODER_MODULUS = BigInt(
  "0xc0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf",
);
const QODER_EXPONENT = 65537n;
const QODER_KEY_BYTES = 128;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let cursor = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return output;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

function rsaPkcs1v15Encrypt(message: Uint8Array): Uint8Array {
  if (message.length > QODER_KEY_BYTES - 11) throw new Error("Qoder RSA message is too long");
  const paddingLength = QODER_KEY_BYTES - message.length - 3;
  const block = new Uint8Array(QODER_KEY_BYTES);
  block[0] = 0;
  block[1] = 2;
  let offset = 2;
  while (offset < 2 + paddingLength) {
    const random = crypto.getRandomValues(new Uint8Array(2));
    for (const byte of random) {
      if (byte !== 0 && offset < 2 + paddingLength) block[offset++] = byte;
    }
  }
  block[offset++] = 0;
  block.set(message, offset);
  return bigIntToBytes(modPow(bytesToBigInt(block), QODER_EXPONENT, QODER_MODULUS), QODER_KEY_BYTES);
}

function leftRotate(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

// Small MD5 implementation for Qoder's legacy COSY signature.
export function md5Hex(input: Uint8Array): string {
  const originalLength = input.length;
  const bitLength = originalLength * 8;
  const paddedLength = (((originalLength + 8) >> 6) + 1) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(input);
  data[originalLength] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      const shift = shifts[Math.floor(index / 16) * 4 + (index % 4)]!;
      b = (b + leftRotate((a + f + constants[index]! + words[g]!) >>> 0, shift)) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0]
    .flatMap((word) => [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff])
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function aesCbcEncrypt(plaintext: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: keyBytes }, key, plaintext);
  return new Uint8Array(encrypted);
}

export async function buildQoderHeaders(
  body: Uint8Array,
  requestUrl: string,
  credential: { userId: string; token: string; name?: string; email?: string; machineId?: string },
): Promise<Record<string, string>> {
  if (!credential.userId || !credential.token) throw new Error("Qoder credential requires user_id and token");
  const aesKeyText = crypto.randomUUID().slice(0, 16);
  const aesKey = encoder.encode(aesKeyText);
  const userInfo = encoder.encode(JSON.stringify({
    uid: credential.userId,
    security_oauth_token: credential.token,
    name: credential.name ?? "",
    aid: "",
    email: credential.email ?? "",
  }));
  const info = base64Encode(await aesCbcEncrypt(userInfo, aesKey));
  const cosyKey = base64Encode(rsaPkcs1v15Encrypt(aesKey));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = crypto.randomUUID();
  const payload = base64Encode(encoder.encode(JSON.stringify({
    version: "v1",
    requestId,
    info,
    cosyVersion: "1.0.0",
    ideVersion: "",
  })));
  const url = new URL(requestUrl);
  const sigPath = url.pathname.startsWith("/algo") ? url.pathname.slice(5) : url.pathname;
  const signatureInput = encoder.encode(`${payload}\n${cosyKey}\n${timestamp}\n${decoder.decode(body)}\n${sigPath}`);
  const machineId = credential.machineId || crypto.randomUUID();

  return {
    Authorization: `Bearer COSY.${payload}.${md5Hex(signatureInput)}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": credential.userId,
    "Cosy-Date": timestamp,
    "Cosy-Version": "1.0.0",
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": "x86_64_windows",
    "Cosy-Clienttype": "5",
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5Hex(body),
    "Cosy-Bodylength": body.length.toString(),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": "disagree",
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": crypto.randomUUID(),
  };
}
