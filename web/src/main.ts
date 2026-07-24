import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import "./styles.css";

const CHUNK_RELOAD_KEY = "cflare:chunk-reload-at";
const CHUNK_RELOAD_PARAM = "__asset_reload";
const CHUNK_RELOAD_COOLDOWN_MS = 30_000;
const CHUNK_LOAD_ERROR = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|load failed for module|chunkloaderror|loading chunk .+ failed|unable to preload (?:css|module)/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : "";
}

function readLastChunkReload(): number {
  try {
    return Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
  } catch {
    return 0;
  }
}

function rememberChunkReload(timestamp: number): void {
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(timestamp));
  } catch {
    // Storage may be unavailable in hardened/private browser contexts.
  }
}

function clearChunkReloadMarker(): void {
  try {
    window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // Storage may be unavailable in hardened/private browser contexts.
  }
}

function recoverFromChunkLoadError(error: unknown): boolean {
  if (!CHUNK_LOAD_ERROR.test(errorMessage(error))) return false;

  const now = Date.now();
  if (now - readLastChunkReload() < CHUNK_RELOAD_COOLDOWN_MS) return false;

  rememberChunkReload(now);
  const url = new URL(window.location.href);
  url.searchParams.set(CHUNK_RELOAD_PARAM, String(now));
  window.location.replace(url.toString());
  return true;
}

window.addEventListener("vite:preloadError", (event) => {
  const preloadEvent = event as Event & { payload?: unknown };
  if (recoverFromChunkLoadError(preloadEvent.payload)) event.preventDefault();
});

router.onError((error) => {
  if (!recoverFromChunkLoadError(error)) console.error("Router navigation failed", error);
});

const currentUrl = new URL(window.location.href);
if (currentUrl.searchParams.has(CHUNK_RELOAD_PARAM)) {
  window.setTimeout(() => {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete(CHUNK_RELOAD_PARAM);
    window.history.replaceState(window.history.state, "", cleanUrl.toString());
    clearChunkReloadMarker();
  }, 10_000);
} else {
  clearChunkReloadMarker();
}

createApp(App).use(createPinia()).use(router).mount("#app");
