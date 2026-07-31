import { defineStore } from "pinia";
import { api, ApiError, jsonBody } from "../api";
import type { Session } from "../types";

/**
 * How long a successful `/session` probe is trusted before the next navigation revalidates.
 *
 * Trade-off: revalidating on every navigation would turn each sidebar click into an extra
 * round trip, and the guard blocks rendering until it resolves, so that cost lands directly
 * on perceived navigation latency. Never revalidating (the previous behaviour) left the SPA
 * believing in a session the server had already dropped. A TTL bounds staleness to one window
 * while keeping steady-state navigation free of `/session` traffic, and the 401 handler
 * closes the remaining gap immediately whenever the server actually rejects a request.
 */
export const SESSION_TTL_MS = 5 * 60 * 1000;

export const useSessionStore = defineStore("session", {
  state: () => ({
    session: null as Session | null,
    /** Epoch ms of the last completed `/session` probe; 0 means "never checked / invalidated". */
    checkedAt: 0,
    loading: false,
    /** De-duplicates concurrent probes so parallel navigations share one request. */
    inflight: null as Promise<void> | null,
  }),
  getters: {
    authenticated: (state) => Boolean(state.session?.authenticated),
  },
  actions: {
    /**
     * Whether the cached session verdict is still trusted. Deliberately an action rather than
     * a getter: getters are cached computeds, and wall-clock time is not a reactive dependency,
     * so a getter would latch on its first value and never expire — reintroducing the very bug
     * this TTL exists to fix.
     */
    isFresh(): boolean {
      if (!this.checkedAt) return false;
      const now = Date.now();
      if (now - this.checkedAt >= SESSION_TTL_MS) return false;
      // Expire early when the server-issued deadline has passed, so a long-lived tab stops
      // rendering the console against a cookie that can no longer authenticate.
      const expiresAt = this.session?.expiresAt;
      if (typeof expiresAt === "number" && expiresAt > 0 && expiresAt * 1000 <= now) return false;
      return true;
    },
    /** Probes `/session` only when the cached verdict has gone stale. */
    async ensureChecked(): Promise<void> {
      if (this.isFresh()) return;
      await this.check();
    },
    async check(): Promise<void> {
      const pending = this.inflight;
      if (pending) return pending;
      const request = (async () => {
        this.loading = true;
        try {
          this.session = await api<Session>("/session");
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          this.session = null;
        } finally {
          this.checkedAt = Date.now();
          this.loading = false;
          this.inflight = null;
        }
      })();
      this.inflight = request;
      return request;
    },
    async login(username: string, password: string) {
      this.loading = true;
      try {
        this.session = await api<Session>("/login", { method: "POST", body: jsonBody({ username, password }) });
        this.checkedAt = Date.now();
      } finally {
        this.loading = false;
      }
    },
    async logout() {
      try {
        await api("/logout", { method: "POST" });
      } finally {
        this.session = null;
        this.checkedAt = Date.now();
      }
    },
    /**
     * Drops the cached session after the server rejected a request with 401, forcing the next
     * navigation guard to treat the user as signed out.
     */
    expire() {
      this.session = null;
      this.checkedAt = 0;
      this.inflight = null;
    },
  },
});
