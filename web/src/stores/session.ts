import { defineStore } from "pinia";
import { api, ApiError, jsonBody } from "../api";
import type { Session } from "../types";

export const useSessionStore = defineStore("session", {
  state: () => ({ session: null as Session | null, checked: false, loading: false }),
  getters: { authenticated: (state) => Boolean(state.session?.authenticated) },
  actions: {
    async check() {
      this.loading = true;
      try { this.session = await api<Session>("/session"); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; this.session = null; }
      finally { this.checked = true; this.loading = false; }
    },
    async login(username: string, password: string) {
      this.loading = true;
      try { this.session = await api<Session>("/login", { method: "POST", body: jsonBody({ username, password }) }); this.checked = true; }
      finally { this.loading = false; }
    },
    async logout() { try { await api("/logout", { method: "POST" }); } finally { this.session = null; this.checked = true; } },
  },
});
