const API_BASE = "/admin/api";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("application/json") ? await response.json().catch(() => ({})) : await response.text();
  if (!response.ok) {
    const value = payload as { error?: { message?: string; code?: string }; message?: string };
    throw new ApiError(value?.error?.message || value?.message || `请求失败 (${response.status})`, response.status, value?.error?.code);
  }
  return payload as T;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const resolvedPath = path === "/overview" ? "/overview-v2" : path;
  const response = await fetch(`${API_BASE}${resolvedPath}`, { ...init, headers, credentials: "same-origin" });
  return parseResponse<T>(response);
}

export const jsonBody = (value: unknown) => JSON.stringify(value);
