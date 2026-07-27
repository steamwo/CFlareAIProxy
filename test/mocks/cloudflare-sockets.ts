/**
 * Programmable stand-in for `cloudflare:sockets`.
 *
 * By default `connect` throws, matching the previous mock so suites that never
 * intend to dial stay honest. Tests that do exercise the native proxy stack
 * call `enqueueSocket` first to hand out scripted sockets: each script controls
 * what the peer sends, when it sends it, and whether it ever sends anything at
 * all (for idle-timeout coverage). Every byte written by the code under test is
 * recorded so handshake framing can be asserted.
 */

export type SocketScriptStep =
  | { type: "data"; bytes: Uint8Array | string }
  /** Blocks until the code under test has written `count` frames in total. */
  | { type: "awaitWrite"; count: number }
  /** Waits `ms` on the (possibly faked) timer queue before the next step. */
  | { type: "delay"; ms: number }
  /** Suspends the script forever, simulating a peer that stops responding. */
  | { type: "stall" }
  /** Half-closes the readable side. */
  | { type: "close" }
  | { type: "error"; error: Error };

export interface SocketScript {
  /** Steps replayed lazily as the readable side is pulled. */
  steps: SocketScriptStep[];
  /** Rejects `socket.opened` instead of resolving it. */
  openError?: Error;
  /** Leaves `socket.opened` pending forever (connect-timeout coverage). */
  openStalls?: boolean;
  /** Script for the socket returned by `startTls()`; defaults to the remainder. */
  afterStartTls?: SocketScript;
  startTlsError?: Error;
  startTlsStalls?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

const pending: SocketScript[] = [];
const recorded: MockSocket[] = [];

/** Queues one scripted socket; connections are served in FIFO order. */
export function enqueueSocket(script: SocketScript): void {
  pending.push(script);
}

export function recordedSockets(): MockSocket[] {
  return recorded;
}

export function resetSockets(): void {
  pending.length = 0;
  recorded.length = 0;
}

export class MockSocket {
  readonly writes: Uint8Array[] = [];
  readonly startTlsCalls: Array<{ expectedServerHostname?: string }> = [];
  isClosed = false;

  readonly opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
  readonly closed: Promise<void>;

  private cursor = 0;
  private readonly writeWaiters: Array<{ count: number; resolve: () => void }> = [];
  private stream: ReadableStream<Uint8Array> | undefined;
  private resolveClosed: (() => void) | undefined;

  constructor(
    readonly address: { hostname: string; port: number } | string,
    readonly options: { secureTransport?: string; allowHalfOpen: boolean } | undefined,
    private readonly script: SocketScript,
  ) {
    this.opened = script.openStalls
      ? new Promise<{ remoteAddress?: string }>(() => undefined)
      : script.openError
        ? Promise.reject(script.openError)
        : Promise.resolve({ remoteAddress: "203.0.113.7" });
    this.opened.catch(() => undefined);
    this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  }

  /** All bytes written by the code under test, decoded as UTF-8. */
  writtenText(): string {
    return decoder.decode(concat(this.writes));
  }

  writtenBytes(): Uint8Array {
    return concat(this.writes);
  }

  get readable(): ReadableStream<Uint8Array> {
    if (!this.stream) this.stream = this.buildStream();
    return this.stream;
  }

  get writable(): WritableStream<Uint8Array> {
    return new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.writes.push(chunk.slice());
        for (let index = this.writeWaiters.length - 1; index >= 0; index -= 1) {
          const waiter = this.writeWaiters[index];
          if (waiter && this.writes.length >= waiter.count) {
            this.writeWaiters.splice(index, 1);
            waiter.resolve();
          }
        }
      },
    });
  }

  get upgraded(): boolean {
    return this.startTlsCalls.length > 0;
  }

  get secureTransport(): "on" | "off" | "starttls" {
    const value = this.options?.secureTransport;
    return value === "on" || value === "starttls" ? value : "off";
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.resolveClosed?.();
  }

  startTls(options?: { expectedServerHostname?: string }): MockSocket {
    this.startTlsCalls.push({ ...(options ?? {}) });
    if (this.script.startTlsError) throw this.script.startTlsError;
    const continuation: SocketScript = this.script.afterStartTls
      ?? { steps: this.script.steps.slice(this.cursor) };
    const upgraded = new MockSocket(
      this.address,
      this.options,
      this.script.startTlsStalls ? { ...continuation, openStalls: true } : continuation,
    );
    recorded.push(upgraded);
    return upgraded;
  }

  private waitForWrites(count: number): Promise<void> {
    if (this.writes.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => { this.writeWaiters.push({ count, resolve }); });
  }

  private buildStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (true) {
          const step = this.script.steps[this.cursor];
          if (!step) { controller.close(); return; }
          this.cursor += 1;
          if (step.type === "data") { controller.enqueue(toBytes(step.bytes)); return; }
          if (step.type === "close") { controller.close(); return; }
          if (step.type === "error") { controller.error(step.error); return; }
          if (step.type === "stall") { await new Promise<never>(() => undefined); return; }
          if (step.type === "delay") { await new Promise<void>((resolve) => setTimeout(resolve, step.ms)); continue; }
          await this.waitForWrites(step.count);
        }
      },
    });
  }
}

export function connect(
  address: { hostname: string; port: number } | string,
  options?: { secureTransport?: string; allowHalfOpen: boolean },
): MockSocket {
  const script = pending.shift();
  if (!script) throw new Error("cloudflare:sockets.connect is unavailable in unit tests");
  const socket = new MockSocket(address, options, script);
  recorded.push(socket);
  return socket;
}
