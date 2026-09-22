import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createDeviceTransport } from "./device-transport"
import { getAuthHeaders } from "@/lib/auth-token"

type ClientOpts = {
  baseUrl: string
  headers?: HeadersInit
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  directory?: string
  throwOnError?: boolean
}

export type DiffFileEntry = {
  path: string
  status: string
  additions: number
  deletions: number
}

export type DiffData = {
  directory: string
  branch: string
  stagedFiles: DiffFileEntry[]
  unstagedFiles: DiffFileEntry[]
  untrackedFiles?: DiffFileEntry[]
}

export type FilteredInfo = {
  strategy?: string
  reason?: string
  path?: string
  originalSize?: number
}

export type DiffContentData = {
  diff: string
  before?: string
  after?: string
  _filtered?: FilteredInfo
}

export type InitStatusAgent = {
  state: string
  healthy: boolean
}

export type InitStatusPrewarm = {
  status: string
  started_at?: string
  finished_at?: string
  error?: string
}

export type InitStatusData = {
  directory: string
  ready: boolean
  agent: InitStatusAgent
  prewarm: InitStatusPrewarm
}

export type RuntimeConfig = {
  allow_absolute_paths: boolean
  max_list_depth: number
  allowed_operations: string[]
  blacklist_count: number
  whitelist_enabled: boolean
}

export type FileMetaData = {
  path: string
  size: number
  modified?: string
  type: "file" | "directory"
}

export type FileReadData = {
  type: "text"
  content: string
  offset: number
  lines: number
  totalLines: number
}

export type DeviceClient = {
  baseUrl: string
  directory?: string
  transport: ReturnType<typeof createDeviceTransport>
  raw: OpencodeClient
  getConfig(): { baseUrl: string }
  global: {
    health: OpencodeClient["global"]["health"]
    event: OpencodeClient["global"]["event"]
    dispose: OpencodeClient["global"]["dispose"]
  }
  runtime: {
    health: () => Promise<{ healthy: boolean; version?: string }>
    config: () => Promise<RuntimeConfig>
    path: () => Promise<unknown>
    vcs: () => Promise<unknown>
    fileList: (path: string) => Promise<Array<{ name: string; path: string; absolute: string; type: "directory" | "file"; ignored: boolean }>>
    roots: () => Promise<Array<{ name: string; path: string; absolute: string; type: "directory" | "file"; ignored: boolean }>>
    fileMeta: (path: string) => Promise<FileMetaData>
    fileRead: (path: string, input?: { offset?: number; limit?: number }) => Promise<FileReadData>
    findFiles: (query: string, dirs: "true" | "false") => Promise<unknown>
    diff: (input?: { staged?: boolean; stat?: boolean; path?: string }) => Promise<DiffData | undefined>
    diffContent: (input?: { staged?: boolean; path?: string }) => Promise<DiffContentData | undefined>
    initStatus: () => Promise<InitStatusData | undefined>
    dispose: () => Promise<unknown>
  }
  agent: {
    list: () => Promise<unknown>
    health: () => Promise<unknown>
    version: () => Promise<unknown>
    models: () => Promise<unknown>
    sessionModes: () => Promise<unknown>
    commands: () => Promise<unknown>
    mcp: () => Promise<unknown>
    lsp: () => Promise<unknown>
  }
  conversation: {
    create: (body?: unknown) => Promise<unknown>
    list: (input?: QueryInput) => Promise<unknown>
    status: () => Promise<unknown>
    get: (id: string) => Promise<unknown>
    update: (id: string, body: unknown) => Promise<unknown>
    delete: (id: string) => Promise<unknown>
    abort: (id: string) => Promise<unknown>
    prompt: (id: string, body: unknown) => Promise<unknown>
    promptAsync: (id: string, body: unknown) => Promise<unknown>
    messages: (id: string, input?: QueryInput) => Promise<unknown>
    todo: (id: string) => Promise<unknown>
    tasks: (id: string) => Promise<unknown>
    diff: (id: string) => Promise<unknown>
    shell: (id: string, body: unknown) => Promise<unknown>
    command: (id: string, body: unknown) => Promise<unknown>
  }
  terminal: {
    create: (input: unknown) => Promise<unknown>
    kill: (id: string) => Promise<unknown>
    resize: (id: string, body: unknown) => Promise<unknown>
    restart: (id: string) => Promise<unknown>
    stream: (id: string) => Promise<unknown>
    input: (id: string, body: unknown) => Promise<unknown>
  }
  permission: {
    list: () => Promise<unknown>
    respond: (id: string, input: unknown) => Promise<unknown>
  }
  question: {
    list: () => Promise<unknown>
    reply: (id: string, input: unknown) => Promise<unknown>
    reject: (id: string) => Promise<unknown>
  }
  event: {
    stream: (input?: { signal?: AbortSignal; onSseError?: (error: unknown) => void }) => Promise<{ stream: AsyncIterable<{ directory?: string; payload: Event }> }>
  }
  provider: OpencodeClient["provider"]
  auth: OpencodeClient["auth"]
  createClient(next: Omit<ClientOpts, "baseUrl" | "headers" | "fetch">): DeviceClient
}

function auth(headers: HeadersInit | undefined, baseUrl: string) {
  return {
    headers,
    baseUrl,
  }
}

export function createDeviceClient(opts: ClientOpts): DeviceClient {
  const http = createDeviceTransport(opts)
  const sdk = createOpencodeClient({
    ...auth({ ...getAuthHeaders(), ...(opts.headers as Record<string, string> | undefined) }, opts.baseUrl),
    fetch: opts.fetch,
    signal: opts.signal,
    directory: opts.directory,
    throwOnError: opts.throwOnError,
  })

  return {
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    transport: http,
    raw: sdk as OpencodeClient,
    getConfig() {
      return { baseUrl: opts.baseUrl }
    },
    global: {
      health: () => sdk.global.health(),
      event: sdk.global.event.bind(sdk.global),
      dispose: () => sdk.global.dispose(),
    },
    runtime: {
      health: () => http.get<{ status?: string; version?: string }>("/api/v1/runtime/health").then((res) => ({ healthy: !!res && (res as any).status === "ok", version: (res as any)?.version })),
      config: () => http.get<RuntimeConfig>("/api/v1/runtime/config"),
      path: () => http.get("/api/v1/runtime/path"),
      vcs: () => http.get("/api/v1/runtime/vcs"),
      fileList: (path: string) => http.get<{ path?: string; entries?: Array<{ name: string; type: string; ignored?: boolean }> }>("/api/v1/runtime/files", { path }).then((res) => {
        const entries = res?.entries ?? []
        const basePath = res?.path ?? path
        return entries.map((e) => ({
          name: e.name,
          path: basePath === "/" ? `/${e.name}` : `${basePath}/${e.name}`,
          absolute: basePath === "/" ? `/${e.name}` : `${basePath}/${e.name}`,
          type: e.type === "directory" ? "directory" as const : "file" as const,
          ignored: e.ignored ?? false,
        }))
      }),
      roots: () => http.get<{ entries?: Array<{ name: string; type: string; ignored?: boolean }> }>("/api/v1/runtime/files", { roots: "true" }).then((res) => {
        const entries = res?.entries ?? []
        return entries.map((e) => ({
          name: e.name,
          path: e.name,
          absolute: e.name,
          type: e.type === "directory" ? "directory" as const : "file" as const,
          ignored: e.ignored ?? false,
        }))
      }),
      fileMeta: (path: string) => http.get<FileMetaData>("/api/v1/runtime/files/meta", { path }),
      fileRead: (path: string, input?: { offset?: number; limit?: number }) => http.get<{ content?: string; lines?: number; offset?: number; total_lines?: number }>("/api/v1/runtime/files/content", {
        path,
        ...(input?.offset ? { offset: input.offset } : {}),
        ...(input?.limit ? { limit: input.limit } : {}),
      }).then((res) => ({
        type: "text" as const,
        content: res?.content ?? "",
        offset: res?.offset ?? input?.offset ?? 1,
        lines: res?.lines ?? 0,
        totalLines: res?.total_lines ?? 0,
      })),
      findFiles: (query: string, dirs: "true" | "false") =>
        http.get("/api/v1/runtime/find/file", { query, dirs }),
    diff: (input?: { staged?: boolean; stat?: boolean; path?: string }) =>
      http.get<DiffData>("/api/v1/runtime/diff", input as Record<string, string | number | boolean | undefined>),
    diffContent: (input?: { staged?: boolean; path?: string }) =>
      http.get<DiffContentData>("/api/v1/runtime/diff/content", input as Record<string, string | number | boolean | undefined>),
      dispose: () => http.post("/api/v1/runtime/dispose"),
      initStatus: () => http.get<InitStatusData>("/api/v1/runtime/init-status"),
    },
    agent: {
      list: () => http.get("/api/v1/agents"),
      health: () => http.get("/api/v1/agents/health"),
      version: () => http.get("/api/v1/agents/version"),
      models: () => http.get("/api/v1/agents/models"),
      sessionModes: () => http.get("/api/v1/agents/session-modes"),
      commands: () => http.get("/api/v1/agents/commands"),
      mcp: () => http.get("/api/v1/agents/mcp"),
      lsp: () => http.get("/api/v1/agents/lsp"),
    },
    conversation: {
      create: (body?: unknown) => http.post("/api/v1/conversations", body),
      list: (input?: QueryInput) => http.get("/api/v1/conversations", input),
      status: () => http.get("/api/v1/conversations/status"),
      get: (id: string) => http.get(`/api/v1/conversations/${id}`),
      update: (id: string, body: unknown) => http.patch(`/api/v1/conversations/${id}`, body),
      delete: (id: string) => http.delete(`/api/v1/conversations/${id}`),
      abort: (id: string) => http.post(`/api/v1/conversations/${id}/abort`),
      prompt: (id: string, body: unknown) => http.post(`/api/v1/conversations/${id}/prompt`, body),
      promptAsync: (id: string, body: unknown) => http.post(`/api/v1/conversations/${id}/prompt/async`, body),
      messages: (id: string, input?: QueryInput) => http.get(`/api/v1/conversations/${id}/messages`, input),
      todo: (id: string) => http.get(`/api/v1/conversations/${id}/todo`),
      tasks: (id: string) => http.get(`/api/v1/conversations/${id}/tasks`),
      diff: (id: string) => http.get(`/api/v1/conversations/${id}/diff`),
      shell: (id: string, body: unknown) => http.post(`/api/v1/conversations/${id}/shell`, body),
      command: (id: string, body: unknown) => http.post(`/api/v1/conversations/${id}/command`, body),
    },
    terminal: {
      create: (input: unknown) => http.post("/api/v1/terminal", input),
      kill: (id: string) => http.delete(`/api/v1/terminal/${id}`),
      resize: (id: string, body: unknown) => http.post(`/api/v1/terminal/${id}/resize`, body),
      restart: (id: string) => http.post(`/api/v1/terminal/${id}/restart`),
      stream: (id: string) => http.get(`/api/v1/terminal/${id}/stream`),
      input: (id: string, body: unknown) => http.post(`/api/v1/terminal/${id}/input`, body),
    },
    permission: {
      list: () => http.get("/api/v1/permissions"),
      respond: (id: string, input: unknown) => http.post(`/api/v1/permissions/${id}/reply`, input),
    },
    question: {
      list: () => http.get("/api/v1/questions"),
      reply: (id: string, input: unknown) => http.post(`/api/v1/questions/${id}/reply`, input),
      reject: (id: string) => http.post(`/api/v1/questions/${id}/reject`),
    },
    event: {
      stream: (input?: { signal?: AbortSignal; onSseError?: (error: unknown) => void }) => {
        const fn = opts.fetch ?? globalThis.fetch
        const url = `${opts.baseUrl.replace(/\/$/, "")}/api/v1/events`
        const controller = new AbortController()
        const signal = input?.signal
        if (signal) signal.addEventListener("abort", () => controller.abort())
        const stream = (async function* () {
          try {
            const res = await fn(url, {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "text/event-stream",
                ...(opts.directory ? { "X-Workspace-Directory": encodeURIComponent(opts.directory) } : {}),
                ...getAuthHeaders(),
                ...(opts.headers ?? {}),
              },
              signal: controller.signal,
            })
            if (!res.ok || !res.body) {
              let proxyCode: string | undefined
              try {
                const text = await res.clone().text()
                const json = JSON.parse(text)
                if (json?.code && typeof json.code === "string") proxyCode = json.code
              } catch {}
              const err = new Error(proxyCode ? `SSE proxy error: ${proxyCode}` : `SSE connect failed: ${res.status}`) as Error & { proxyCode?: string }
              if (proxyCode) err.proxyCode = proxyCode
              input?.onSseError?.(err)
              return
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const text = line.slice(6).trim()
                if (!text) continue
                try {
                  const parsed = JSON.parse(text)
                  yield { directory: parsed.directory, payload: parsed.payload ?? parsed }
                } catch {}
              }
            }
          } catch (e) {
            if ((e as any)?.name !== "AbortError") input?.onSseError?.(e)
          }
        })()
        return Promise.resolve({ stream })
      },
    },
    provider: sdk.provider,
    auth: sdk.auth,
    createClient(next: Omit<ClientOpts, "baseUrl" | "headers" | "fetch">) {
      return createDeviceClient({
        ...opts,
        ...next,
      })
    },
  }
}

type QueryInput = Record<string, string | number | boolean | undefined>
