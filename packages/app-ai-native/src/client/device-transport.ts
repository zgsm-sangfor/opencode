import { onUnauthorized } from "@/lib/session-expired"
import { onRateLimited } from "@/lib/rate-limit-toast"
import { getAuthHeaders } from "@/lib/auth-token"

export type TransportOpts = {
  baseUrl: string
  headers?: HeadersInit
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  directory?: string
}

type Query = Record<string, string | number | boolean | undefined>

function join(base: string, path: string) {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
}

function buildQuery(path: string, input?: Query) {
  if (!input) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  const text = params.toString()
  if (!text) return path
  return `${path}?${text}`
}

export class DeviceHttpError extends Error {
  code: string
  status: number
  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "DeviceHttpError"
    this.status = status
    this.code = code
  }
}

export const PROXY_ERROR_CODES = new Set(["UPSTREAM_ERROR", "FILTER_ERROR", "TERMINAL_DISABLED", "RUNTIME_FILE_DISABLED", "RUNTIME_TREE_DISABLED", "RUNTIME_DIFF_DISABLED"])

export function isProxyError(e: unknown): e is DeviceHttpError {
  if (e instanceof DeviceHttpError) return PROXY_ERROR_CODES.has(e.code)
  if (e && typeof e === "object" && "code" in e) return PROXY_ERROR_CODES.has((e as any).code)
  return false
}

export function isNotFoundError(e: unknown): e is DeviceHttpError {
  if (e instanceof DeviceHttpError) return e.status === 404
  return false
}

export function isRuntimeFileDisabledError(e: unknown): boolean {
  if (e instanceof DeviceHttpError) return e.code === "RUNTIME_FILE_DISABLED"
  if (e && typeof e === "object") {
    if ("code" in e && (e as any).code === "RUNTIME_FILE_DISABLED") return true
    const err = (e as any).error
    if (err && typeof err === "object" && err.code === "RUNTIME_FILE_DISABLED") return true
  }
  return false
}

export function isBinaryFileError(e: unknown): boolean {
  if (e instanceof DeviceHttpError) return e.code === "BINARY_FILE"
  if (e && typeof e === "object") {
    if ("code" in e && (e as any).code === "BINARY_FILE") return true
    const err = (e as any).error
    if (err && typeof err === "object" && err.code === "BINARY_FILE") return true
  }
  return false
}

export function isRuntimeTreeDisabledError(e: unknown): boolean {
  if (e instanceof DeviceHttpError) return e.code === "RUNTIME_TREE_DISABLED"
  if (e && typeof e === "object") {
    if ("code" in e && (e as any).code === "RUNTIME_TREE_DISABLED") return true
    const err = (e as any).error
    if (err && typeof err === "object" && err.code === "RUNTIME_TREE_DISABLED") return true
  }
  return false
}

export function isRuntimeDiffDisabledError(e: unknown): boolean {
  if (e instanceof DeviceHttpError) return e.code === "RUNTIME_DIFF_DISABLED"
  if (e && typeof e === "object") {
    if ("code" in e && (e as any).code === "RUNTIME_DIFF_DISABLED") return true
    const err = (e as any).error
    if (err && typeof err === "object" && err.code === "RUNTIME_DIFF_DISABLED") return true
  }
  return false
}

export function createDeviceTransport(opts: TransportOpts) {
  const run = async <T>(method: string, path: string, input?: { query?: Query; body?: unknown; signal?: AbortSignal; directory?: string }) => {
    const fn = opts.fetch ?? globalThis.fetch
    const dir = input?.directory ?? opts.directory
    const res = await fn(join(opts.baseUrl, buildQuery(path, input?.query)), {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(dir ? { "X-Workspace-Directory": encodeURIComponent(dir) } : {}),
        ...getAuthHeaders(),
        ...opts.headers,
      },
      signal: input?.signal ?? opts.signal,
      body: method !== "GET" && method !== "HEAD" ? JSON.stringify(input?.body ?? {}) : undefined,
    })

    const rawText = await res.text().catch(() => "")
    let data: any
    try {
      data = rawText ? JSON.parse(rawText) : undefined
    } catch {
      data = undefined
    }

    if (!res.ok) {
      if (res.status === 401) onUnauthorized(path)
      if (res.status === 429) onRateLimited()
      let payload = data
      if (payload && typeof payload === "object" && "ok" in payload && "error" in payload) {
        payload = payload.error
      }
      if (payload && typeof payload === "object") {
        throw new DeviceHttpError(payload.message ?? payload.error ?? String(payload), res.status, payload.code ?? "UNKNOWN")
      }
      throw new DeviceHttpError(`Request failed: ${res.status}`, res.status, "UNKNOWN")
    }

    if (res.status === 204 || res.status === 205) return { data: undefined as T, response: res }

    if (data && typeof data === "object" && "ok" in data && "data" in data && data.data != null) {
      data = data.data
    }

    return { data: data as T, response: res }
  }

  return {
    get<T>(path: string, input?: Query & { directory?: string }, signal?: AbortSignal) {
      const { directory, ...query } = input ?? ({} as Query & { directory?: string })
      return run<T>("GET", path, { query, signal, directory }).then((result) => result.data)
    },
    getResponse<T>(path: string, input?: Query & { directory?: string }, signal?: AbortSignal) {
      const { directory, ...query } = input ?? ({} as Query & { directory?: string })
      return run<T>("GET", path, { query, signal, directory })
    },
    post<T>(path: string, body?: unknown, signal?: AbortSignal) {
      return run<T>("POST", path, { body, signal }).then((result) => result.data)
    },
    put<T>(path: string, body?: unknown, signal?: AbortSignal) {
      return run<T>("PUT", path, { body, signal }).then((result) => result.data)
    },
    patch<T>(path: string, body?: unknown, signal?: AbortSignal) {
      return run<T>("PATCH", path, { body, signal }).then((result) => result.data)
    },
    delete<T>(path: string, signal?: AbortSignal) {
      return run<T>("DELETE", path, { signal }).then((result) => result.data)
    },
  }
}
