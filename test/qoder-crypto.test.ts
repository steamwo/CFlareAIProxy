import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/providers/qoder-crypto";

describe("Qoder legacy MD5", () => {
  it("matches RFC 1321 vectors", () => {
    const encoder = new TextEncoder();
    expect(md5Hex(encoder.encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(encoder.encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(encoder.encode("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  });
});
