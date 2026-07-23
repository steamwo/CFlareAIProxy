import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto";
import { GatewayError, normalizeGatewayError } from "../src/errors";

function base64Key(bytes = 32): string {
  return Buffer.alloc(bytes, 7).toString("base64");
}

describe("secret encryption configuration errors", () => {
  it("reports a missing MASTER_KEY", async () => {
    await expect(encryptSecret("proxy", undefined)).rejects.toMatchObject({
      status: 503,
      code: "MASTER_KEY_MISSING",
      type: "configuration_error",
    });
  });

  it("reports an invalid MASTER_KEY encoding", async () => {
    await expect(encryptSecret("proxy", "%%%not-base64%%%" )).rejects.toMatchObject({
      status: 503,
      code: "INVALID_MASTER_KEY",
      type: "configuration_error",
    });
  });

  it("reports an invalid MASTER_KEY length", async () => {
    await expect(encryptSecret("proxy", base64Key(31))).rejects.toMatchObject({
      status: 503,
      code: "INVALID_MASTER_KEY",
      type: "configuration_error",
    });
  });

  it("encrypts and decrypts with a valid key", async () => {
    const key = base64Key();
    const encrypted = await encryptSecret("socks5://user:pass@example.com:1080", key);
    await expect(decryptSecret(encrypted, key)).resolves.toBe("socks5://user:pass@example.com:1080");
  });

  it("preserves MASTER_KEY errors while decrypting", async () => {
    const encrypted = await encryptSecret("proxy", base64Key());
    await expect(decryptSecret(encrypted, undefined)).rejects.toBeInstanceOf(GatewayError);
    await expect(decryptSecret(encrypted, undefined)).rejects.toMatchObject({ code: "MASTER_KEY_MISSING" });
  });
});

describe("D1 error normalization", () => {
  it("recognizes missing columns as pending migrations", () => {
    expect(normalizeGatewayError(new Error("D1_ERROR: no such column: system_settings.value_ciphertext"))).toMatchObject({
      status: 503,
      code: "DATABASE_MIGRATION_REQUIRED",
      type: "configuration_error",
    });
  });

  it("recognizes insert errors caused by missing columns", () => {
    expect(normalizeGatewayError(new Error("table provider_proxies has no column named proxy_url_ciphertext"))).toMatchObject({
      status: 503,
      code: "DATABASE_MIGRATION_REQUIRED",
      type: "configuration_error",
    });
  });
});
