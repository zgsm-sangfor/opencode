import { createContext, useContext, type ParentProps } from "solid-js"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { isNotFoundError } from "@/client/device-transport"
import { useDeviceSDK } from "./device-sdk"
import { useDeviceWorkspace } from "./device-workspace"
import { useLanguage } from "./language"
import type { Message, Part, Session, SessionStatus, FileDiff, Todo, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"

export type SessionError = {
  subtype?: string
  level?: string
  message?: string
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
}

export type TaskState = {
  taskID: string
  status: "running" | "completed" | "failed" | "stopped"
  description: string
  taskType?: string
  summary?: string
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  startTime: number
  endTime?: number
}

type SessionSlice = {
  session: Session | undefined
  messages: Record<string, Message[]>
  parts: Record<string, Part[]>
  status: Record<string, SessionStatus>
  diffs: Record<string, FileDiff[]>
  todos: Record<string, Todo[]>
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  errors: Record<string, SessionError>
  toolProgress: Record<string, string>
  partProgress: Record<string, string[]>
  tasks: Record<string, Record<string, TaskState>>
  updating: Record<string, boolean>
}

type StoreValue = {
  data: SessionSlice
  loadMessages: (sessionID: string, limit?: number) => Promise<void>
  syncSession: (sessionID: string) => Promise<void>
  loadTasks: (sessionID: string) => Promise<void>
  diff: (sessionID: string) => Promise<void>
  todo: (sessionID: string) => Promise<void>
  optimisticAdd: (input: { sessionID: string; message: Message; parts: Part[] }) => void
  optimisticRemove: (input: { sessionID: string; messageID: string }) => void
  addOptimisticMessage: (input: {
    sessionID: string
    messageID: string
    parts: Part[]
    agent: string
    model: { providerID: string; modelID: string }
  }) => void
  historyMore: (sessionID: string) => boolean
  historyLoading: (sessionID?: string) => boolean
  historyLoadMore: (sessionID: string, count?: number) => Promise<void>
  permissionRespond: (input: { permissionID: string; response: "once" | "always" | "reject" }) => void
}

type DeviceSessionValue = {
  data: {
    session: Session | undefined
    messages: Record<string, Message[]>
    parts: Record<string, Part[]>
    status: SessionStatus | undefined
    diffs: FileDiff[]
    todos: Todo[]
    permissions: Record<string, PermissionRequest[]>
    questions: Record<string, QuestionRequest[]>
    error: SessionError | undefined
    toolProgress: Record<string, string>
    partProgress: Record<string, string[]>
    tasks: Record<string, TaskState>
  }
  set: any
  sessionID: () => string | undefined
  sync: () => Promise<void>
  loadMessages: (sessionID: string, limit?: number) => Promise<void>
  reconcileMessages: (sessionID: string) => Promise<void>
  diff: (sessionID: string) => Promise<void>
  todo: (sessionID: string) => Promise<void>
  optimistic: {
    add(input: { sessionID: string; message: Message; parts: Part[] }): void
    remove(input: { sessionID: string; messageID: string }): void
  }
  addOptimisticMessage(input: {
    sessionID: string
    messageID: string
    parts: Part[]
    agent: string
    model: { providerID: string; modelID: string }
  }): void
  history: {
    more(sessionID: string): boolean
    loading(sessionID?: string): boolean
    loadMore(sessionID: string, count?: number): Promise<void>
  }
  permission: {
    respond(input: { permissionID: string; response: "once" | "always" | "reject" }): void
    isAutoAccepting(): boolean
    toggleAutoAccept(): void
    enableAutoAccept(): void
    disableAutoAccept(): void
    enabled(): boolean
  }
}

const MESSAGE_PAGE_SIZE = 50
const MESSAGE_INITIAL_LIMIT = 200
const idle: SessionStatus = { type: "idle" }

// ── Shared Store Context ──

const StoreContext = createContext<StoreValue>()

export function useDeviceSessionStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useDeviceSessionStore must be used within DeviceSessionStoreProvider")
  return ctx
}

// ── Per-Session Context ──

const DeviceSessionContext = createContext<DeviceSessionValue>()

export function useDeviceSession() {
  const ctx = useContext(DeviceSessionContext)
  if (!ctx) throw new Error("useDeviceSession must be used within DeviceSessionProvider")
  return ctx
}

export { DeviceSessionContext }

// ── Helpers ──

export function group<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

export function treeItems<T extends { id?: string; sessionID?: string }>(input: T[], ids: Set<string>) {
  return group(
    input.filter((item): item is T & { id: string; sessionID: string } => {
      return !!item?.id && !!item.sessionID && ids.has(item.sessionID)
    }),
  )
}

export function treeEvent(input: {
  root?: string
  eventSID?: string
  type: string
  tree: Set<string>
}) {
  if (!input.root) return false
  if (!input.eventSID) return true
  return input.tree.has(input.eventSID)
}

// ── Shared Store Provider ──

export function DeviceSessionStoreProvider(props: ParentProps) {
  const device = useDeviceSDK()
  const workspace = useDeviceWorkspace()
  const language = useLanguage()

  const [store, setStore] = createStore<SessionSlice>({
    session: undefined,
    messages: {},
    parts: {},
    status: {},
    diffs: {},
    todos: {},
    permissions: {},
    questions: {},
    errors: {},
    toolProgress: {},
    partProgress: {},
    tasks: {},
    updating: {},
  })

  const inflight = new Map<string, Promise<void>>()
  const loadingSessions = new Set<string>()

  const runInflight = (key: string, task: () => Promise<void>) => {
    const pending = inflight.get(key)
    if (pending) return pending
    const promise = task().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  const BATCH_SIZE = 10

  const loadMessages = async (sessionID: string, limit?: number) => {
    if (store.messages[sessionID]?.length) return
    return runInflight(`messages:${sessionID}`, async () => {
      loadingSessions.add(sessionID)
      try {
        const loadLimit = limit ?? MESSAGE_INITIAL_LIMIT
        const result = await device.client.conversation.messages(sessionID, { limit: loadLimit })
        if (!result) return
        const raw = Array.isArray(result) ? result : []

        const fetched = new Map<string, { info: Message; parts?: Part[] }>()
        for (const item of raw as any[]) {
          if (!item?.info?.id) continue
          fetched.set(item.info.id, {
            info: item.info as Message,
            parts: Array.isArray(item.parts) ? (item.parts as Part[]) : undefined,
          })
        }

        const msgs = [...fetched.values()].map((d) => d.info)
        setStore("messages", sessionID, msgs)

        for (const [mid, data] of fetched) {
          if (data.parts && data.parts.length > 0) {
            setStore("parts", mid, data.parts)
          }
        }
      } finally {
        loadingSessions.delete(sessionID)
      }
    })
  }

  const syncSession = async (sessionID: string) => {
    if (!sessionID || !workspace.agentAvailable()) return
    try {
      await Promise.allSettled([
        device.client.conversation.get(sessionID).then((result) => {
          if (result) setStore("session", result as Session)
        }),
        loadTasks(sessionID),
      ])
    } catch {}
  }

  const loadTasks = async (id: string) => {
    try {
      const result = await device.client.conversation.tasks(id) as any
      if (!result?.tasks || !Array.isArray(result.tasks)) return
      const taskMap: Record<string, TaskState> = {}
      for (const t of result.tasks) {
        if (t?.taskID) {
          taskMap[t.taskID] = {
            taskID: t.taskID,
            status: t.status ?? "completed",
            description: t.description ?? "",
            taskType: t.taskType,
            summary: t.summary,
            usage: t.usage,
            startTime: t.startTime ?? Date.now(),
            endTime: t.endTime,
          }
        }
      }
      setStore("tasks", id, taskMap)
    } catch {}
  }

  const diffSession = async (sessionID: string) => {
    if (!workspace.agentAvailable()) return
    return runInflight(`diff:${sessionID}`, async () => {
      try {
        const result = await device.client.conversation.diff(sessionID)
        const diffs = ((result as FileDiff[]) ?? [])
        setStore("diffs", sessionID, diffs)
      } catch {}
    })
  }

  const todoSession = async (sessionID: string) => {
    if (!workspace.agentAvailable()) return
    return runInflight(`todo:${sessionID}`, async () => {
      try {
        const result = await device.client.conversation.todo(sessionID) as Todo[] | { todos?: Todo[] } | undefined
        const todos = Array.isArray(result) ? result : Array.isArray(result?.todos) ? result.todos : []
        setStore("todos", sessionID, todos)
      } catch {}
    })
  }

  const optimisticAdd = (input: { sessionID: string; message: Message; parts: Part[] }) => {
    setStore(produce((draft) => {
      if (!draft.messages[input.sessionID]) draft.messages[input.sessionID] = []
      draft.messages[input.sessionID].push(input.message)
      if (input.parts.length > 0 && input.message.id) {
        draft.parts[input.message.id] = input.parts
      }
    }))
  }

  const optimisticRemove = (input: { sessionID: string; messageID: string }) => {
    setStore(produce((draft) => {
      const list = draft.messages[input.sessionID]
      if (list) {
        const idx = list.findIndex((m) => m.id === input.messageID)
        if (idx !== -1) list.splice(idx, 1)
      }
      delete draft.parts[input.messageID]
    }))
  }

  const addOptimisticMessage = (input: {
    sessionID: string
    messageID: string
    parts: Part[]
    agent: string
    model: { providerID: string; modelID: string }
  }) => {
    const message: Message = {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: input.agent,
      model: input.model,
    }
    optimisticAdd({ sessionID: input.sessionID, message, parts: input.parts })
  }

  // SSE subscription — process ALL session events
  const allSessionTree = createMemo(() => {
    const tree = new Set<string>()
    for (const s of workspace.data.session) tree.add(s.id)
    return tree
  })

  const unsubscribe = workspace.subscribe((payload) => {
    const eventSID = payload.sessionID ?? (payload.properties as any)?.sessionID ?? ((payload.properties as any)?.part as any)?.sessionID ?? ((payload.properties as any)?.info as any)?.sessionID ?? ((payload.properties as any)?.status as any)?.sessionID ?? ((payload.properties as any)?.diff as any[])?.[0]?.sessionID ?? ((payload.properties as any)?.todos as any[])?.[0]?.sessionID

    batch(() => {
      switch (payload.type) {
        case "message.updated": {
          const info = (payload.properties as { info?: Message })?.info
          if (!info?.id) break
          const msgSID = eventSID ?? info.sessionID
          if (!msgSID) break

          if (info.role === "user" && store.errors[msgSID]) setStore("errors", msgSID, undefined as any)
          if (!store.messages[msgSID]) setStore("messages", msgSID, [])
          setStore("messages", msgSID, produce((draft: Message[]) => {
            const idx = draft.findIndex((m) => m.id === info.id)
            if (idx !== -1) {
              const existing = draft[idx] as Record<string, unknown> | undefined
              const incoming = info as Record<string, unknown> | undefined
              if (
                existing?.time && typeof existing.time === "object" && (existing.time as Record<string, unknown>)?.created &&
                incoming?.time && typeof incoming.time === "object" && !(incoming.time as Record<string, unknown>)?.created && (incoming.time as Record<string, unknown>)?.completed
              ) {
                draft[idx] = { ...info, time: { created: (existing.time as Record<string, unknown>).created, ...incoming.time } } as Message
              } else {
                draft[idx] = info
              }
            } else {
              draft.push(info)
            }
          }))
          break
        }
        case "message.part.updated": {
          const part = (payload.properties as { part?: Part })?.part
          if (!part?.id) break
          const messageID = part.messageID
          if (!messageID) break
          const partCallID = (part as any).callID as string | undefined
          const partStatus = (part as any).state?.status as string | undefined
          const partProgress = (part as any).state?.progress as string[] | undefined
          const partTool = (part as any).tool as string | undefined
          const partInput = (part as any).state?.input as { todos?: Todo[] } | undefined
          if (partTool === "todowrite" && partInput?.todos && eventSID) {
            setStore("todos", eventSID, partInput.todos)
          }
          if (partCallID) {
            if (partStatus === "completed" || partStatus === "error") {
              setStore("partProgress", partCallID, undefined as any)
            } else if (Array.isArray(partProgress)) {
              setStore("partProgress", partCallID, partProgress.length > 10 ? partProgress.slice(-10) : partProgress)
            }
          }
          const existing = store.parts[messageID]
          if (!existing) {
            setStore("parts", messageID, [part])
            break
          }
          const idx = existing.findIndex((p) => p.id === part.id)
          if (idx !== -1) {
            const prev = existing[idx] as any
            const merged = (part as any).state?.output === undefined && prev?.state?.output !== undefined
              ? { ...part, state: { ...(part as any).state, output: prev.state.output } }
              : part
            setStore("parts", messageID, idx, merged)
          } else {
            const callID = (part as any).callID
            if (callID) {
              const byCall = existing.findIndex((p) => (p as any).callID === callID)
              if (byCall !== -1) {
                const prev = existing[byCall] as any
                const base = { ...part, id: existing[byCall].id }
                const patched = (part as any).state?.output === undefined && prev?.state?.output !== undefined
                  ? { ...base, state: { ...(part as any).state, output: prev.state.output } }
                  : base
                setStore("parts", messageID, byCall, patched)
                break
              }
            }
            setStore("parts", messageID, existing.length, part)
          }
          break
        }
        case "message.part.delta": {
          const props = payload.properties as { messageID: string; partID: string; field: string; delta: string }
          if (!props.messageID || !props.partID) break
          const parts = store.parts[props.messageID]
          if (!parts) break
          const idx = parts.findIndex((p) => p.id === props.partID)
          if (idx === -1) break
          setStore("parts", props.messageID, idx, produce((draft: any) => {
            if (props.field === "input" && draft.type === "tool" && draft.state) {
              const existing = (draft.state.input as string) ?? ""
              draft.state.input = existing + props.delta
            } else {
              const field = props.field as keyof typeof draft
              const existing = draft[field] as string | undefined
              ;(draft[field] as string) = (existing ?? "") + props.delta
            }
          }))
          break
        }
        case "message.removed": {
          const props = payload.properties as { sessionID?: string; messageID?: string }
          if (!props.messageID) break
          const msgSID = eventSID ?? props.sessionID ?? ""
          if (!store.messages[msgSID]) break
          setStore("messages", msgSID, produce((draft: Message[]) => {
            const idx = draft.findIndex((m) => m.id === props.messageID)
            if (idx !== -1) draft.splice(idx, 1)
          }))
          setStore("parts", produce((draft) => {
            delete draft[props.messageID!]
          }))
          break
        }
        case "session.diff": {
          const props = payload.properties as { sessionID?: string; diff?: FileDiff[] }
          if (props.diff && eventSID) setStore("diffs", eventSID, props.diff)
          break
        }
        case "todo.updated": {
          const props = payload.properties as { sessionID?: string; todos?: Todo[] }
          if (props.todos && eventSID) setStore("todos", eventSID, props.todos)
          break
        }
        case "session.error": {
          const props = payload.properties as { sessionID?: string; error?: string | SessionError; message?: string }
          if (!eventSID) break
          const err: SessionError = typeof props.error === "object" && props.error !== null
            ? props.error
            : { message: props.message }
          setStore("errors", eventSID, err)
          // showToast({
          //   variant: "error",
          //   title: language.t("notification.session.error.title"),
          //   description: err.message ?? language.t("notification.session.error.fallbackDescription"),
          // })
          break
        }
        case "tool.progress": {
          const props = payload.properties as { sessionID?: string; toolUseID?: string; parentToolUseID?: string; data?: string }
          const toolUseID = props.toolUseID ?? props.parentToolUseID
          if (!toolUseID || !props.data) break
          setStore("toolProgress", toolUseID, (existing: string | undefined) => (existing ?? "") + props.data)
          break
        }
        case "task.started": {
          const props = payload.properties as { sessionID?: string; taskID?: string; description?: string; taskType?: string }
          if (!props.taskID || !eventSID) break
          setStore("tasks", eventSID, props.taskID, {
            taskID: props.taskID,
            status: "running",
            description: props.description ?? "",
            taskType: props.taskType,
            startTime: Date.now(),
          })
          break
        }
        case "task.progress": {
          const props = payload.properties as { sessionID?: string; taskID?: string; description?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number }; summary?: string }
          if (!props.taskID || !eventSID) break
          const existing = store.tasks[eventSID]?.[props.taskID]
          if (!existing) break
          setStore("tasks", eventSID, props.taskID, produce((draft: TaskState) => {
            if (props.description) draft.description = props.description
            if (props.usage) draft.usage = props.usage
            if (props.summary) draft.summary = props.summary
          }))
          break
        }
        case "task.completed": {
          const props = payload.properties as { sessionID?: string; taskID?: string; status?: string; summary?: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number } }
          if (!props.taskID || !eventSID) break
          const existing = store.tasks[eventSID]?.[props.taskID]
          const endTime = Date.now()
          setStore("tasks", eventSID, props.taskID, {
            taskID: props.taskID,
            status: (props.status === "completed" || props.status === "failed" || props.status === "stopped") ? props.status : "completed",
            description: existing?.description ?? "",
            taskType: existing?.taskType,
            summary: props.summary ?? existing?.summary,
            usage: props.usage ?? existing?.usage,
            startTime: existing?.startTime ?? endTime,
            endTime,
          })
          break
        }
      }
    })
  })
  onCleanup(() => unsubscribe())

  const permissionRespond = (input: { permissionID: string; response: "once" | "always" | "reject" }) => {
    if (!workspace.agentAvailable()) return
    device.client.permission.respond(input.permissionID, {
      decision: input.response,
    }).catch((err: unknown) => {
      if (isNotFoundError(err)) {
        const perms = workspace.data.permissions
        for (const [sid, list] of Object.entries(perms)) {
          if (!Array.isArray(list)) continue
          const idx = list.findIndex((p) => p.id === input.permissionID)
          if (idx !== -1) {
            workspace.session.removePermission(sid, input.permissionID)
            break
          }
        }
      }
    })
  }

  const historyLoading = (sessionID?: string) => {
    if (sessionID) return inflight.has(`messages:${sessionID}`)
    for (const key of inflight.keys()) {
      if (key.startsWith("messages:")) return true
    }
    return false
  }

  const storeValue: StoreValue = {
    get data() { return store },
    loadMessages,
    syncSession,
    loadTasks,
    diff: diffSession,
    todo: todoSession,
    optimisticAdd,
    optimisticRemove,
    addOptimisticMessage,
    historyMore: (sessionID: string) => (store.messages[sessionID]?.length ?? 0) >= MESSAGE_PAGE_SIZE,
    historyLoading,
    historyLoadMore: async (sessionID: string, count?: number) => {
      // No-op once cached: loadMessages only writes on cold start (no cache),
      // so this is effective only for the very first load. After that SSE is
      // the sole writer. To re-enable incremental history loading, loadMessages
      // needs a bypass flag or this needs its own fetch path.
      const current = store.messages[sessionID]?.length ?? 0
      await loadMessages(sessionID, current + (count ?? MESSAGE_PAGE_SIZE))
    },
    permissionRespond,
  }

  return <StoreContext.Provider value={storeValue}>{props.children}</StoreContext.Provider>
}

// ── Per-Session Provider ──

export function DeviceSessionProvider(props: ParentProps<{ sessionID?: string }>) {
  const store = useDeviceSessionStore()
  const workspace = useDeviceWorkspace()
  const sid = createMemo(() => props.sessionID)

  const data = {
    get session() { return store.data.session },
    get messages() { return store.data.messages },
    get parts() { return store.data.parts },
    get status() { return sid() ? (store.data.status[sid()!] ?? idle) : undefined },
    get diffs() { return sid() ? (store.data.diffs[sid()!] ?? []) : [] },
    get todos() { return sid() ? (store.data.todos[sid()!] ?? []) : [] },
    get permissions() { return store.data.permissions },
    get questions() { return store.data.questions },
    get error() { return sid() ? store.data.errors[sid()!] : undefined },
    get toolProgress() { return store.data.toolProgress },
    get partProgress() { return store.data.partProgress },
    get tasks() { return sid() ? (store.data.tasks[sid()!] ?? {}) : {} },
  }

  const value: DeviceSessionValue = {
    get data() { return data },
    set: (() => {}) as any,
    sessionID: sid,
    sync: () => store.syncSession(sid() ?? ""),
    loadMessages: store.loadMessages,
    reconcileMessages: async (sessionID: string) => {
      await store.loadMessages(sessionID, MESSAGE_PAGE_SIZE)
    },
    diff: store.diff,
    todo: store.todo,
    optimistic: {
      add: store.optimisticAdd,
      remove: store.optimisticRemove,
    },
    addOptimisticMessage: store.addOptimisticMessage,
    history: {
      more: store.historyMore,
      loading: store.historyLoading,
      loadMore: store.historyLoadMore,
    },
    permission: {
      respond: store.permissionRespond,
      isAutoAccepting() {
        return workspace.autoAccept.enabled()
      },
      toggleAutoAccept() {
        workspace.autoAccept.toggle()
      },
      enableAutoAccept() {
        workspace.autoAccept.enable()
      },
      disableAutoAccept() {
        workspace.autoAccept.disable()
      },
      enabled() {
        return workspace.agentAvailable()
      },
    },
  }

  return <DeviceSessionContext.Provider value={value}>{props.children}</DeviceSessionContext.Provider>
}
