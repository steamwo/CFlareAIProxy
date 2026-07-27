import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { useSessionStore } from "./session";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, api: apiMock };
});

const authenticated = { authenticated: true, username: "admin", expiresAt: 0, service: "cfap" };

beforeEach(() => {
  setActivePinia(createPinia());
  apiMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session store revalidation", () => {
  it("trusts a fresh check without re-probing /session", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();

    await store.check();
    expect(store.isFresh()).toBe(true);
    expect(store.authenticated).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(store.isFresh()).toBe(true);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("expires the cached verdict once the TTL elapses", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();

    await store.check();
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(store.isFresh()).toBe(false);
  });

  it("expires early when the server-issued session deadline has passed", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    apiMock.mockResolvedValue({ ...authenticated, expiresAt });
    const store = useSessionStore();

    await store.check();
    expect(store.isFresh()).toBe(true);

    vi.advanceTimersByTime(31_000);
    expect(store.isFresh()).toBe(false);
  });

  it("treats a 401 from /session as signed out rather than an error", async () => {
    apiMock.mockRejectedValue(new ApiError("nope", 401));
    const store = useSessionStore();

    await store.check();

    expect(store.session).toBeNull();
    expect(store.authenticated).toBe(false);
    expect(store.isFresh()).toBe(true);
  });

  it("rethrows non-401 failures so they are not mistaken for a sign-out", async () => {
    apiMock.mockRejectedValue(new ApiError("boom", 500));
    const store = useSessionStore();

    await expect(store.check()).rejects.toThrow("boom");
  });

  it("shares one in-flight probe across concurrent callers", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();

    await Promise.all([store.check(), store.check(), store.check()]);

    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("forces a fresh probe after expire()", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();
    await store.check();

    store.expire();

    expect(store.isFresh()).toBe(false);
    expect(store.authenticated).toBe(false);
  });

  it("ensureChecked probes once per TTL window rather than once per navigation", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();

    // Simulate a burst of navigations inside one TTL window.
    await store.ensureChecked();
    await store.ensureChecked();
    vi.advanceTimersByTime(60_000);
    await store.ensureChecked();
    expect(apiMock).toHaveBeenCalledTimes(1);

    // Crossing the TTL boundary revalidates exactly once more.
    vi.advanceTimersByTime(5 * 60 * 1000);
    await store.ensureChecked();
    await store.ensureChecked();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("marks the session trusted right after login without an extra probe", async () => {
    apiMock.mockResolvedValue(authenticated);
    const store = useSessionStore();

    await store.login("admin", "secret");

    expect(store.authenticated).toBe(true);
    expect(store.isFresh()).toBe(true);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
