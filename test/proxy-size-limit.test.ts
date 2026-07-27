import { describe, expect, it } from "vitest";
import { SocketReader } from "../src/proxy-transport";

function dialect() {
  return {
    headersTooLarge: () => new Error("headers too large"),
    headersClosed: () => new Error("headers closed"),
    idleTimeout: () => new Error("idle timeout"),
  } as never;
}

describe("proxy response size limits", () => {
  it("rejects a terminator that appears beyond the configured limit in one socket read", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${"x".repeat(64)}\r\n\r\n`));
        controller.close();
      },
    });
    const reader = new SocketReader(body, { idleTimeoutMs: 1_000, dialect: dialect() });
    await expect(reader.readUntil(new TextEncoder().encode("\r\n\r\n"), 32)).rejects.toThrow("headers too large");
  });
});
