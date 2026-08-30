export type BrainxErrorPayload = { error?: { code?: string; message?: string } | string } & Record<string, unknown>;

export class BrainxApiError extends Error {
  status: number;
  code: string | undefined;
  payload: BrainxErrorPayload | undefined;
  kind: "AUTH" | "CONFLICT" | "VALIDATION" | "UNAVAILABLE" | "HTTP";

  constructor(message: string, status = 0, code?: string, payload?: BrainxErrorPayload) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.kind = status === 401 || status === 403 ? "AUTH"
      : status === 409 ? "CONFLICT"
      : status === 400 || status === 422 ? "VALIDATION"
      : status >= 500 ? "UNAVAILABLE" : "HTTP";
  }
}

/** 浏览器端唯一 HTTP 边界；错误信封在这里统一转成可分类异常。 */
export async function brainxFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method || "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  if (response.status === 204) return null as T;
  let data: T | BrainxErrorPayload | null = null;
  try { data = await response.json(); } catch { /* 非 JSON 响应体 */ }
  if (!response.ok) {
    const raw = (data as BrainxErrorPayload | null)?.error;
    const message = raw && typeof raw === "object"
      ? raw.message || `HTTP ${response.status}`
      : typeof raw === "string" ? raw : `HTTP ${response.status}`;
    const code = raw && typeof raw === "object" ? raw.code : undefined;
    throw new BrainxApiError(message, response.status, code, data as BrainxErrorPayload);
  }
  return data as T;
}
