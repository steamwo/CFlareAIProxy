import { ref, type Ref } from "vue";
import { useMessage } from "naive-ui";
import { ApiError } from "../api";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunOptions<T> {
  /** Toast shown when the task resolves. Omit to stay silent on success. */
  success?: string | ((value: T) => string);
  /**
   * Toast tone used when the task throws. Defaults to "error"; pass "none" for call sites
   * that surface the failure through their own UI instead of a toast.
   */
  failureTone?: "error" | "warning" | "none";
  /** Ref toggled around the task. Defaults to the composable's shared `loading` ref. */
  loading?: Ref<boolean> | null;
  /** Rethrow after reporting, for callers that need to branch on failure. */
  rethrow?: boolean;
}

export interface ApiRequest {
  /** True while any task started without an explicit `loading` override is in flight. */
  loading: Ref<boolean>;
  /**
   * Runs `task` with loading bookkeeping and unified failure reporting.
   * Resolves to the task's value, or `undefined` when it failed and `rethrow` is not set.
   */
  run: <T>(task: () => Promise<T>, options?: RunOptions<T>) => Promise<T | undefined>;
  /** Reports a failure through the same channel as `run`, for manually caught errors. */
  reportError: (error: unknown, tone?: "error" | "warning") => string;
}

/**
 * Wraps the loading + try/catch + toast triad that every view repeated by hand.
 *
 * A 401 is reported but intentionally left silent: the API layer already routes it to the
 * global sign-out handler, so a per-view toast would only add noise to a page the user is
 * being redirected away from.
 */
export function useApiRequest(): ApiRequest {
  const message = useMessage();
  const loading = ref(false);

  function reportError(error: unknown, tone: "error" | "warning" = "error"): string {
    const text = errorText(error);
    if (error instanceof ApiError && error.status === 401) return text;
    if (tone === "warning") message.warning(text);
    else message.error(text);
    return text;
  }

  async function run<T>(task: () => Promise<T>, options: RunOptions<T> = {}): Promise<T | undefined> {
    const tracked = options.loading === undefined ? loading : options.loading;
    if (tracked) tracked.value = true;
    try {
      const value = await task();
      const { success } = options;
      if (success) message.success(typeof success === "function" ? success(value) : success);
      return value;
    } catch (error) {
      if (options.failureTone !== "none") reportError(error, options.failureTone ?? "error");
      if (options.rethrow) throw error;
      return undefined;
    } finally {
      if (tracked) tracked.value = false;
    }
  }

  return { loading, run, reportError };
}
