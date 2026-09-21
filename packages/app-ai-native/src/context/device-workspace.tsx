import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useDeviceSDK } from "./device-sdk"
import { syncSummary, clearSummary } from "./workspace-summary-store"
import { getDirectory } from "@opencode-ai/util/path"
import type { Session, Command, Agent, VcsInfo, SessionStatus, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client"
import type { ProviderCapabilitiesResponse } from "./global-sync/types"
import { workspaceApi } from "@/pages/workspace/lib/api"
import { scheduleNotifPromptCheck, type NotifPromptTexts } from "@/utils/notification-prompt"
import { uuid } from "@/utils/uuid"
import { useLanguage } from "./language"


function groupBy<T extends { id?: string; sessionID?: string }>(items: T[]): Record<string, T[]> {
  const map: Record<string, T[]> = {}
  for (const item of items) {
    if (!item?.id || !item.sessionID) continue
    const list = map[item.sessionID]
    if (list) list.push(item)
    else map[item.sessionID] = [item]
  }
  return map
}

function arr<T>(res: unknown, key?: string): T[] {
  if (Array.isArray(res)) return res as T[]
  if (key && res && typeof res === "object" && Array.isArray((res as any)[key])) return (res as any)[key] as T[]
  return []
}

type WorkspaceData = {
  status: "loading" | "ready" | "unavailable"
  agent: Agent[]
  command: Command[]
  session: Session[]
  sessionStatus: Record<string, SessionStatus>
  questions: Record<string, QuestionRequest[]>
  permissions: Record<string, PermissionRequest[]>
  sessionTotal: number
  vcs: VcsInfo | undefined
  provider: ProviderCapabilitiesResponse
  agentAvailable: boolean
  agentInfo: { name: string; version?: string } | undefined
  unread: Record<string, boolean>
}

type EventPayload = { type: string; sessionID?: string; messageID?: string; properties?: any; [key: string]: unknown }

export type RestartState = { active: true; phase: string; message: string } | { active: false }

type DeviceWorkspaceValue = {
  data: WorkspaceData
  ready: () => boolean
  agentAvailable: () => boolean
  project: {
    worktree: string
    name: string | undefined
    time: { created: number; updated: number }
  }
  session: {
    get: (id: string) => Session | undefined
    fetch(count?: number): Promise<void>
    remove(id: string): Promise<void>
    removeLocal(id: string): void
    patch(id: string, partial: Partial<Session>): void
    setStatus(id: string, status: SessionStatus | undefined): void
    setQuestions(questions: Record<string, QuestionRequest[]>): void
    setPermissions(permissions: Record<string, PermissionRequest[]>): void
    removePermission(sessionID: string, requestID: string): void
    removeQuestion(sessionID: string, requestID: string): void
    clearUnread(id: string): void
  }
  command: {
    load(): Promise<Command[]>
  }
  vcs: {
    load(): Promise<VcsInfo | undefined>
  }
  subscribe(fn: (payload: EventPayload) => void): () => void
  directory: string
  workspaceId: string | undefined
  proxyError: () => string | undefined
  autoAccept: {
    enabled: () => boolean
    toggle(): void
    enable(): void
    disable(): void
  }
  restartAgent: () => Promise<void>
  restarting: () => RestartState
}

const DeviceWorkspaceContext = createContext<DeviceWorkspaceValue>()

export function useDeviceWorkspace() {
  const ctx = useContext(DeviceWorkspaceContext)
  if (!ctx) throw new Error("useDeviceWorkspace must be used within DeviceWorkspaceProvider")
  return ctx
}

export { DeviceWorkspaceContext }

export function DeviceWorkspaceProvider(props: ParentProps<{ workspaceId?: string }>) {
  const device = useDeviceSDK()
  const language = useLanguage()
  const navigate = useNavigate()

  const [store, setStore] = createStore<WorkspaceData>({
    status: "loading",
    agent: [],
    command: [],
    session: [],
    sessionStatus: {},
    questions: {},
    permissions: {},
    sessionTotal: 0,
    vcs: undefined,
    provider: { connected: [] } as ProviderCapabilitiesResponse,
    agentAvailable: true,
    agentInfo: undefined,
    unread: {},
  })

  const checkAgentAvailable = async () => {
    try {
      const res = await device.client.agent.health() as any
      const agents = res?.agents ?? res
      if (Array.isArray(agents) && agents.length > 0) {
        const anyAvailable = agents.some((a: any) => a.available)
        setStore("agentAvailable", anyAvailable)
        const first = agents.find((a: any) => a.available) ?? agents[0]
        setStore("agentInfo", { name: first.backend ?? first.name ?? first.id })
        return anyAvailable
      }
      setStore("agentAvailable", true)
      setStore("agentInfo", undefined)
      return true
    } catch {
      setStore("agentAvailable", false)
      setStore("agentInfo", undefined)
      return false
    }
  }

  const checkAgentVersion = async () => {
    try {
      const res = await device.client.agent.version() as any
      const agents = res?.agents
      if (Array.isArray(agents) && agents.length > 0) {
        const version = agents[0].version
        if (version) {
          setStore("agentInfo", (prev) => (prev ? { ...prev, version } : { name: "", version }))
        }
      }
    } catch {
      // 404 or other errors: version info unavailable, keep existing agentInfo without version
    }
  }

  const bootstrap = async () => {
    setStore("status", "loading")
    try {
      const agentAvailable = await checkAgentAvailable()
      if (!agentAvailable) {
        setStore("status", "unavailable")
        return
      }

      // Fire-and-forget: version query may be slow, don't block bootstrap
      checkAgentVersion()

      const [sessionsRes, vcsRes] = await Promise.all([
        device.client.conversation.list({ roots: "true", limit: 50, directory: device.directory }).catch(() => undefined),
        device.client.runtime.vcs().catch(() => undefined),
      ])

      if (props.workspaceId) {
        workspaceApi.get(props.workspaceId)
          .then((res) => {
            const val = (res?.workspace?.settings as Record<string, any>)?.autoAccept
            if (val === true) {
              setAutoAcceptSignal(true)
              respondAllPermissions()
            }
          })
          .catch(() => {})
      }

      const [allSessionsRes, sessionStatusRes, permsRes, questionsRes] = await Promise.all([
        device.client.conversation.list({ limit: 50 }).catch(() => undefined),
        device.client.conversation.status().catch(() => undefined),
        device.client.permission.list().catch(() => undefined),
        device.client.question.list().catch(() => undefined),
      ])

      const agentPromise = Promise.all([
        device.client.agent.sessionModes().catch(() => undefined),
        device.client.agent.models().catch(() => undefined),
      ])

      batch(() => {
        const rootSessions = (Array.isArray(sessionsRes) ? sessionsRes : []) as Session[]
        const allSessions = (Array.isArray(allSessionsRes) ? allSessionsRes : []) as Session[]
        const children = allSessions.filter((s) => !!s?.id && !!s.parentID)
        const merged = [...rootSessions, ...children].filter((s) => !!s?.id)
        setStore("session", reconcile(merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), { key: "id" }))
        setStore("sessionStatus", reconcile((sessionStatusRes as Record<string, SessionStatus>) ?? {}))
        setStore("sessionTotal", rootSessions.length)
        setStore("vcs", vcsRes as VcsInfo | undefined)
        setStore("questions", reconcile(groupBy(arr<QuestionRequest>(questionsRes))))
        setStore("permissions", reconcile(groupBy(arr<PermissionRequest>(permsRes, "permissions"))))
        setStore("status", "ready")
        if (props.workspaceId) {
          syncSummary(props.workspaceId, {
            vcs: vcsRes as VcsInfo | undefined,
            sessionStatus: (sessionStatusRes as Record<string, SessionStatus>) ?? {},
            questions: groupBy(arr<QuestionRequest>(questionsRes)),
            permissions: groupBy(arr<PermissionRequest>(permsRes, "permissions")),
          })
        }
      })

      agentPromise.then(([agentsRes, providersRes]) => {
        batch(() => {
          setStore("agent", reconcile((agentsRes as Agent[]) ?? [], { key: "name" }))
          const providerData = (providersRes as ProviderCapabilitiesResponse) ?? { connected: [] }
          setStore("provider", reconcile(providerData, { key: "id" }))
        })
      })

      // If auto-accept was already enabled before permissions were stored, respond now
      if (autoAcceptSignal()) respondAllPermissions()

      void startEventStream()
    } catch {
      setStore("status", "unavailable")
    }
  }

  void bootstrap()

  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const RETRY_INTERVAL = 5000

  const scheduleRetry = () => {
    if (retryTimer) return
    retryTimer = setTimeout(async () => {
      retryTimer = undefined
      if (store.agentAvailable) return
      const available = await checkAgentAvailable()
      if (available) {
        await bootstrap()
      } else {
        scheduleRetry()
      }
    }, RETRY_INTERVAL)
  }

  createEffect(() => {
    if (!store.agentAvailable) scheduleRetry()
  })

  onCleanup(() => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  })

  const getSession = (id: string) => store.session.find((s) => s.id === id)

  const setSessionStatus = (id: string, status: SessionStatus | undefined) => {
    if (!id) return
    if (!status || status.type === "idle") {
      setStore("sessionStatus", produce((draft) => {
        delete draft[id]
      }))
      return
    }
    setStore("sessionStatus", id, reconcile(status))
  }

  const patchSession = (id: string, partial: Partial<Session>) => {
    if (!id) return
    setStore("session", produce((draft: Session[]) => {
      const idx = draft.findIndex((s) => s.id === id)
      if (idx === -1) return
      draft[idx] = {
        ...draft[idx],
        ...partial,
        time: { ...draft[idx].time, updated: Date.now() },
      }
    }))
  }

  const addQuestion = (item: QuestionRequest) => {
    if (!item?.id || !item?.sessionID) return
    if (!store.questions[item.sessionID]) {
      setStore("questions", item.sessionID, [item])
      return
    }
    if (store.questions[item.sessionID].some((r) => r.id === item.id)) return
    setStore("questions", item.sessionID, produce((draft: QuestionRequest[]) => {
      draft.push(item)
    }))
  }

  const removeQuestion = (sessionID: string, requestID: string) => {
    if (!sessionID || !requestID) return
    const list = store.questions[sessionID]
    if (!list) return
    const idx = list.findIndex((r) => r.id === requestID)
    if (idx === -1) return
    setStore("questions", sessionID, produce((draft: QuestionRequest[]) => {
      draft.splice(idx, 1)
    }))
  }

  const addPermission = (item: PermissionRequest): boolean => {
    if (!item?.id || !item?.sessionID) return false
    if (!store.permissions[item.sessionID]) {
      setStore("permissions", item.sessionID, [item])
      return true
    }
    if (store.permissions[item.sessionID].some((r) => r.id === item.id)) return false
    setStore("permissions", item.sessionID, produce((draft: PermissionRequest[]) => {
      draft.push(item)
    }))
    return true
  }

  const removePermission = (sessionID: string, requestID: string) => {
    if (!sessionID || !requestID) return
    const list = store.permissions[sessionID]
    if (!list) return
    const idx = list.findIndex((r) => r.id === requestID)
    if (idx === -1) return
    setStore("permissions", sessionID, produce((draft: PermissionRequest[]) => {
      draft.splice(idx, 1)
    }))
  }

  const respondAllPermissions = () => {
    for (const [sid, list] of Object.entries(store.permissions)) {
      if (!Array.isArray(list)) continue
      for (const perm of list) {
        device.client.permission
          .respond(perm.id, { decision: "once" })
          .then(() => {
            removePermission(sid, perm.id)
            scheduleSummarySync()
          })
          .catch(() => {
            removePermission(sid, perm.id)
            scheduleSummarySync()
          })
      }
    }
  }

  const fetchSessions = async (count = 10) => {
    if (!store.agentAvailable) return
    try {
      const [result, statusResult] = await Promise.all([
        device.client.conversation.list({ roots: "true", limit: 50, directory: device.directory }),
        device.client.conversation.status().catch(() => undefined),
      ])
      const sessions = (result as Session[]) ?? []
      batch(() => {
        setStore("session", reconcile(sessions.filter((s) => !!s?.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), { key: "id" }))
        setStore("sessionStatus", reconcile((statusResult as Record<string, SessionStatus>) ?? {}))
        setStore("sessionTotal", sessions.length)
      })
    } catch {}
  }

  const removeSessionLocal = (id: string) => {
    batch(() => {
      setStore("session", produce((draft) => {
        const idx = draft.findIndex((s) => s.id === id)
        if (idx !== -1) draft.splice(idx, 1)
      }))
      setSessionStatus(id, undefined)
      setStore("unread", produce((draft) => { delete draft[id] }))
      setStore("questions", produce((draft) => { delete draft[id] }))
      setStore("permissions", produce((draft) => { delete draft[id] }))
      if (props.workspaceId) {
        syncSummary(props.workspaceId, {
          vcs: store.vcs,
          sessionStatus: store.sessionStatus,
          questions: store.questions,
          permissions: store.permissions,
          hasUnreadSession: store.session.some((s) => !s.parentID && store.unread[s.id]),
        })
      }
    })
  }

  const deleteSession = async (id: string) => {
    if (!store.agentAvailable) return
    try {
      await device.client.conversation.delete(id)
      removeSessionLocal(id)
    } catch {}
  }

  const loadCommands = async (): Promise<Command[]> => {
    if (!store.agentAvailable) return []
    if (store.command.length > 0) return store.command
    try {
      const result = await device.client.agent.commands()
      const list = (result as Command[]) ?? []
      setStore("command", reconcile(list, { key: "name" }))
      return list
    } catch {
      return []
    }
  }

  const loadVcs = async (): Promise<VcsInfo | undefined> => {
    if (store.vcs !== undefined) return store.vcs
    try {
      const result = await device.client.runtime.vcs()
      setStore("vcs", result as VcsInfo | undefined)
        if (props.workspaceId) {
          syncSummary(props.workspaceId, {
            vcs: result as VcsInfo | undefined,
            sessionStatus: store.sessionStatus,
            questions: store.questions,
            permissions: store.permissions,
            hasUnreadSession: store.session.some((s) => !s.parentID && store.unread[s.id]),
          })
      }
      return result as VcsInfo | undefined
    } catch {
      return undefined
    }
  }

  let vcsRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let vcsRefreshDelay = 500

  const refreshVcs = (delay?: number) => {
    const actualDelay = delay ?? vcsRefreshDelay

    if (vcsRefreshTimer) {
      clearTimeout(vcsRefreshTimer)
    }

    vcsRefreshTimer = setTimeout(async () => {
      vcsRefreshTimer = undefined
      try {
        const result = await device.client.runtime.vcs()
        batch(() => {
          setStore("vcs", result as VcsInfo | undefined)
          if (props.workspaceId) {
            syncSummary(props.workspaceId, {
              vcs: result as VcsInfo | undefined,
              sessionStatus: store.sessionStatus,
              questions: store.questions,
              permissions: store.permissions,
              hasUnreadSession: store.session.some((s) => !s.parentID && store.unread[s.id]),
            })
          }
        })
      } catch {}
    }, actualDelay)
  }

  const listeners = new Set<(payload: EventPayload) => void>()

  const subscribe = (fn: (payload: EventPayload) => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  const dispatch = (payload: EventPayload) => {
    for (const fn of listeners) {
      try { fn(payload) } catch {}
    }
  }

  const [autoAcceptSignal, setAutoAcceptSignal] = createSignal(false)
  const [proxyError, setProxyError] = createSignal<string | undefined>(undefined)

  const persistAutoAccept = async (value: boolean) => {
    const wid = props.workspaceId
    if (!wid) return
    setAutoAcceptSignal(value)
    try {
      await workspaceApi.update(wid, { settings: { autoAccept: value } })
    } catch {}
  }

  const autoAccept = {
    enabled: () => autoAcceptSignal(),
    toggle() { persistAutoAccept(!autoAcceptSignal()) },
    enable() { persistAutoAccept(true) },
    disable() { persistAutoAccept(false) },
  }

  const [restarting, setRestarting] = createSignal<RestartState>({ active: false })

  const rebootstrap = async () => {
    // Abort old stream without touching session/status state
    streamAbort?.abort()
    streamAbort = undefined
    clearDebounceTimers()

    const available = await checkAgentAvailable().catch(() => false)
    if (!available) return

    // Fire-and-forget: version query may be slow, don't block rebootstrap
    checkAgentVersion()

    const agentPromise = Promise.all([
      device.client.agent.sessionModes().catch(() => undefined),
      device.client.agent.models().catch(() => undefined),
      device.client.agent.commands().catch(() => undefined),
    ])

    // Refresh session list, status, permissions, questions, vcs
    const [sessionsRes, vcsRes] = await Promise.all([
      device.client.conversation.list({ roots: "true", limit: 50, directory: device.directory }).catch(() => undefined),
      device.client.runtime.vcs().catch(() => undefined),
    ])

    const [allSessionsRes, sessionStatusRes, permsRes, questionsRes] = await Promise.all([
      device.client.conversation.list({ limit: 50 }).catch(() => undefined),
      device.client.conversation.status().catch(() => undefined),
      device.client.permission.list().catch(() => undefined),
      device.client.question.list().catch(() => undefined),
    ])

    batch(() => {
      const rootSessions = (Array.isArray(sessionsRes) ? sessionsRes : []) as Session[]
      const allSessions = (Array.isArray(allSessionsRes) ? allSessionsRes : []) as Session[]
      const children = allSessions.filter((s) => !!s?.id && !!s.parentID)
      const merged = [...rootSessions, ...children].filter((s) => !!s?.id)
      setStore("session", reconcile(merged.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), { key: "id" }))
      setStore("sessionStatus", reconcile((sessionStatusRes as Record<string, SessionStatus>) ?? {}))
      setStore("sessionTotal", rootSessions.length)
      setStore("vcs", vcsRes as VcsInfo | undefined)
      setStore("questions", reconcile(groupBy(arr<QuestionRequest>(questionsRes))))
      setStore("permissions", reconcile(groupBy(arr<PermissionRequest>(permsRes, "permissions"))))
      if (props.workspaceId) {
        syncSummary(props.workspaceId, {
          vcs: vcsRes as VcsInfo | undefined,
          sessionStatus: (sessionStatusRes as Record<string, SessionStatus>) ?? {},
          questions: groupBy(arr<QuestionRequest>(questionsRes)),
          permissions: groupBy(arr<PermissionRequest>(permsRes, "permissions")),
        })
      }
    })

    agentPromise.then(([agentsRes, providersRes, commandsRes]) => {
      batch(() => {
        setStore("agent", reconcile((agentsRes as Agent[]) ?? [], { key: "name" }))
        const providerData = (providersRes as ProviderCapabilitiesResponse) ?? { connected: [] }
        setStore("provider", reconcile(providerData, { key: "id" }))
        setStore("command", reconcile((commandsRes as Command[]) ?? [], { key: "name" }))
      })
    })

    startEventStream()
  }

  const restartAgent = async () => {
    const id = uuid()
    const maxTime = Date.now() + 30_000
    setRestarting({ active: true, phase: "", message: "Sending restart command..." })

    const poll = async () => {
      if (Date.now() > maxTime) {
        setRestarting({ active: false })
        return
      }
      try {
        const status: any = await device.client.transport.get(`/api/v1/commands/status?command_id=${id}`)
        if (status.status === "completed" || status.status === "failed") {
          setRestarting({ active: false })
          // rebootstrap is now driven by the server-side SSE event
          // agent.runtime.restarted, which covers all affected workspaces
          return
        }
        setRestarting({ active: true, phase: status.phase ?? "", message: status.message ?? "" })
        setTimeout(poll, 500)
      } catch {
        setTimeout(poll, 500)
      }
    }

    try {
      await device.client.transport.post("/api/v1/commands", {
        command_id: id,
        type: "restart-agent",
        timestamp: new Date().toISOString(),
      })
      setTimeout(poll, 300)
    } catch {
      setRestarting({ active: false })
    }
  }

  // ── SSE event debounce infrastructure ──

  const STATUS_DEBOUNCE_MS = 150
  const UPDATE_DEBOUNCE_MS = 250
  const SUMMARY_DEBOUNCE_MS = 100

  // ── Watchdog: fallback for dropped session.status events ──
  // If a session is stuck in busy/retry longer than STALE_MS without any
  // status event, poll the authoritative /session/status and correct it.
  const WATCHDOG_INTERVAL_MS = 60_000
  const STALE_MS = 90_000
  const RETRY_GRACE_MS = 30_000
  const WATCHDOG_MAX_FAILURES = 5
  const lastEventAt = new Map<string, number>()
  let watchdogFailures = 0
  let watchdogTimer: ReturnType<typeof setInterval> | undefined

  const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingStatus = new Map<string, SessionStatus>()

  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const pendingUpdates = new Map<string, Record<string, unknown>>()

  let summaryTimer: ReturnType<typeof setTimeout> | undefined

  const mergeDeep = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...target }
    for (const key of Object.keys(source)) {
      const sv = source[key]
      if (sv !== null && typeof sv === "object" && !Array.isArray(sv)) {
        out[key] = mergeDeep((out[key] as Record<string, unknown>) ?? {}, sv as Record<string, unknown>)
      } else {
        out[key] = sv
      }
    }
    return out
  }

  const scheduleSummarySync = () => {
    const wid = props.workspaceId
    if (!wid) return
    if (summaryTimer) clearTimeout(summaryTimer)
    summaryTimer = setTimeout(() => {
      summaryTimer = undefined
      syncSummary(wid, {
        vcs: store.vcs,
        sessionStatus: store.sessionStatus,
        questions: store.questions,
        permissions: store.permissions,
        hasUnreadSession: store.session.some((s) => !s.parentID && store.unread[s.id]),
      })
    }, SUMMARY_DEBOUNCE_MS)
  }

  const flushStatus = (id: string) => {
    const status = pendingStatus.get(id)
    if (!status) return
    const prev = store.sessionStatus[id]
    const wasBusy = prev?.type === "busy" || prev?.type === "retry" || prev?.type === "compacting"
    const nowIdle = status.type === "idle"
    setSessionStatus(id, status)
    if (wasBusy && nowIdle) {
      setStore("unread", id, true)
    } else if (status.type === "busy" || status.type === "retry" || status.type === "compacting") {
      setStore("unread", produce((d) => { delete d[id] }))
    }
    scheduleSummarySync()
  }

  const flushUpdates = () => {
    updateTimer = undefined
    if (pendingUpdates.size === 0) return
    batch(() => {
      for (const [id, partial] of pendingUpdates) {
        setStore("session", produce((draft) => {
          const idx = draft.findIndex((s) => s.id === id)
          if (idx !== -1) {
            draft[idx] = mergeDeep(draft[idx] as Record<string, unknown>, partial) as any
          }
        }))
      }
      pendingUpdates.clear()
    })
    scheduleSummarySync()
  }

  const clearDebounceTimers = () => {
    for (const t of statusTimers.values()) clearTimeout(t)
    statusTimers.clear()
    pendingStatus.clear()
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined }
    pendingUpdates.clear()
    if (summaryTimer) { clearTimeout(summaryTimer); summaryTimer = undefined }
  }

  // ── Watchdog sweep: detect sessions stuck in busy/retry due to dropped
  // idle events, and correct them from the authoritative /session/status. ──
  const runWatchdogSweep = async () => {
    if (watchdogFailures >= WATCHDOG_MAX_FAILURES) return
    if (!store.agentAvailable) return

    const now = Date.now()
    const stale = new Set<string>()
    for (const [id, status] of Object.entries(store.sessionStatus)) {
      if (status.type === "retry") {
        if (now > status.next + RETRY_GRACE_MS) stale.add(id)
        continue
      }
      if (status.type === "busy" || status.type === "compacting") {
        const last = lastEventAt.get(id) ?? 0
        if (now - last > STALE_MS) stale.add(id)
      }
    }
    if (stale.size === 0) return

    let fresh: Record<string, SessionStatus>
    try {
      const res = await device.client.conversation.status()
      fresh = (res as Record<string, SessionStatus>) ?? {}
    } catch {
      watchdogFailures++
      return
    }
    watchdogFailures = 0

    batch(() => {
      for (const id of stale) {
        const remote = fresh[id]
        const local = store.sessionStatus[id]
        if (!local || local.type === "idle") continue
        if (remote && remote.type === "idle") {
          setSessionStatus(id, { type: "idle" })
          lastEventAt.set(id, now)
        } else if (remote) {
          lastEventAt.set(id, now)
        }
      }
    })
  }

  const stopWatchdog = () => {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = undefined }
  }

  let streamAbort: AbortController | undefined
  let streamAliveTimer: ReturnType<typeof setTimeout> | undefined
  let streamDisposed = false
  let streamFailures = 0

  const STREAM_MAX_FAILURES = 5
  const STREAM_ALIVE_TIMEOUT_MS = 30_000

  const PROXY_FATAL_CODES = new Set(["FILTER_ERROR"])

  const disarmAliveTimer = () => {
    if (streamAliveTimer) {
      clearTimeout(streamAliveTimer)
      streamAliveTimer = undefined
    }
  }

  const onAliveTimeout = () => {
    streamAliveTimer = undefined
    streamFailed()
  }

  const armAliveTimer = () => {
    disarmAliveTimer()
    streamAliveTimer = setTimeout(onAliveTimeout, STREAM_ALIVE_TIMEOUT_MS)
  }

  const streamFailed = () => {
    disarmAliveTimer()
    streamFailures += 1
    if (streamFailures > STREAM_MAX_FAILURES) {
      streamDisposed = true
      streamAbort?.abort()
      streamAbort = undefined
      clearDebounceTimers()
      setStore("status", "unavailable")
      return
    }
    void rebootstrap()
  }

  const startEventStream = async () => {
    streamAbort?.abort()
    clearDebounceTimers()
    streamAbort = new AbortController()
    const signal = streamAbort.signal
    try {
      const { stream } = await device.client.event.stream({
        signal,
        onSseError: (err) => {
          const proxyCode = (err as any)?.proxyCode as string | undefined
          if (proxyCode) {
            setProxyError(proxyCode)
            if (!PROXY_FATAL_CODES.has(proxyCode)) {
              streamFailed()
            }
          }
        },
      })
      const readLoop = async () => {
        try {
          setProxyError(undefined)
          streamFailures = 0
          armAliveTimer()
          for await (const event of stream as any) {
            if (signal.aborted) break
            armAliveTimer()
            if (!event) continue
            const payload = (event.payload ?? event) as EventPayload
            if (!payload?.type) continue

            batch(() => {
              let summaryChanged = false
              switch (payload.type) {
                // ── session.created: no debounce, immediate ──
                case "session.created": {
                  const info = (payload.properties as { info?: Session })?.info ?? payload.properties as Session
                  if (!info?.id) break
                  // upstream may omit `time`; keep the store well-formed so sort/group reads never see undefined
                  const session = info.time ? info : { ...info, time: { created: Date.now(), updated: Date.now() } }
                  setStore("session", produce((draft) => {
                    const idx = draft.findIndex((s) => s.id === session.id)
                    if (idx !== -1) draft[idx] = session
                    else {
                      draft.push(session)
                      draft.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                    }
                  }))
                  summaryChanged = true
                  break
                }
                // ── session.updated: debounce per sessionID with field merge ──
                case "session.updated": {
                  const p = payload.properties as { sessionID?: string; info?: Session; [k: string]: unknown }
                  const id = p?.sessionID ?? payload.sessionID
                  if (!id) break
                  const partial = p.info ?? p
                  const existing = pendingUpdates.get(id) ?? {}
                  pendingUpdates.set(id, mergeDeep(existing, partial as Record<string, unknown>))
                  if (updateTimer) clearTimeout(updateTimer)
                  updateTimer = setTimeout(flushUpdates, UPDATE_DEBOUNCE_MS)
                  break
                }
                // ── session.deleted: no debounce, immediate ──
                case "session.deleted": {
                  const dp = payload.properties as { sessionID?: string; info?: Session }
                  const id = dp?.sessionID ?? dp?.info?.id ?? payload.sessionID
                  if (!id) break
                  batch(() => {
                    setStore("session", produce((draft) => {
                      const idx = draft.findIndex((s) => s.id === id)
                      if (idx !== -1) draft.splice(idx, 1)
                    }))
                    setSessionStatus(id, undefined)
                    setStore("unread", produce((draft) => { delete draft[id] }))
                    setStore("questions", produce((draft) => { delete draft[id] }))
                    setStore("permissions", produce((draft) => { delete draft[id] }))
                    lastEventAt.delete(id)
                  })
                  summaryChanged = true
                  break
                }
                // ── session.status: debounce per sessionID, idle is immediate ──
                case "session.status": {
                  const sp = payload.properties as { sessionID?: string; status?: SessionStatus | string }
                  const id = sp?.sessionID ?? payload.sessionID
                  // upstream gateway may emit status as a bare string ("compacting") instead of { type }: normalize
                  const raw = sp?.status
                  const status: SessionStatus | undefined = typeof raw === "string" ? ({ type: raw } as SessionStatus) : raw
                  if (!id || !status) break
                  lastEventAt.set(id, Date.now())
                  // idle must be immediate
                  if (status.type === "idle") {
                    const existingTimer = statusTimers.get(id)
                    if (existingTimer) {
                      clearTimeout(existingTimer)
                      statusTimers.delete(id)
                      if (pendingStatus.has(id)) flushStatus(id)
                    }
                    const prev = store.sessionStatus[id]
                    const wasBusy = prev?.type === "busy" || prev?.type === "retry" || prev?.type === "compacting"
                    setSessionStatus(id, status)
                    if (wasBusy) setStore("unread", id, true)
                    scheduleSummarySync()
                    break
                  }
                  // busy/retry: debounce
                  const wasIdle = !store.sessionStatus[id] || store.sessionStatus[id]?.type === "idle"
                  pendingStatus.set(id, status)
                  const existingTimer = statusTimers.get(id)
                  if (existingTimer) clearTimeout(existingTimer)
                  statusTimers.set(id, setTimeout(() => {
                    statusTimers.delete(id)
                    flushStatus(id)
                    if (wasIdle) {
                      scheduleNotifPromptCheck((path) => {
                        navigate(path)
                      }, {
                        title: language.t("workspace.notifPrompt.title"),
                        description: language.t("workspace.notifPrompt.description"),
                        configure: language.t("workspace.notifPrompt.configure"),
                        dismiss: language.t("workspace.notifPrompt.dismiss"),
                      })
                    }
                  }, STATUS_DEBOUNCE_MS))
                  break
                }
                // ── question/permission: no debounce (low-freq + immediate response) ──
                case "question.asked": {
                  const q = payload.properties as QuestionRequest
                  if (q?.id) { addQuestion(q); summaryChanged = true }
                  break
                }
                case "question.replied":
                case "question.rejected": {
                  const p = payload.properties as { sessionID?: string; requestID?: string }
                  removeQuestion(p?.sessionID ?? "", p?.requestID ?? "")
                  summaryChanged = true
                  break
                }
                case "permission.asked": {
                  const p = payload.properties as PermissionRequest
                  if (p?.id) {
                    const added = addPermission(p)
                    if (added) summaryChanged = true
                    if (added && autoAcceptSignal()) {
                      const sid = p.sessionID ?? ""
                      const pid = p.id
                      device.client.permission
                        .respond(pid, { decision: "once" })
                        .then(() => {
                          removePermission(sid, pid)
                          scheduleSummarySync()
                        })
                        .catch(() => {
                          removePermission(sid, pid)
                          scheduleSummarySync()
                        })
                    }
                  }
                  break
                }
                case "permission.replied": {
                  const p = payload.properties as { sessionID?: string; requestID?: string }
                  removePermission(p?.sessionID ?? "", p?.requestID ?? "")
                  summaryChanged = true
                  break
                }
                case "session.error": {
                  const p = payload.properties as { sessionID?: string }
                  const id = p?.sessionID ?? payload.sessionID
                  if (!id) break
                  summaryChanged = true
                  break
                }
                // ── git events: no debounce on handler, refreshVcs already debounced ──
                case "host.git.branch.changed": {
                  const p = payload.properties as { new_branch?: string; old_branch?: string; repo_path?: string }
                  if (p?.new_branch == null) break
                  const eventRepoPath = p.repo_path ? getDirectory(p.repo_path) : ""
                  const currentRepoPath = getDirectory(device.directory)
                  if (eventRepoPath !== currentRepoPath) break
                  const prev = store.vcs
                  if (prev?.branch === p.new_branch) break
                  setStore("vcs", { ...prev, branch: p.new_branch })
                  summaryChanged = true
                  break
                }
                case "host.git.commit": {
                  const p = payload.properties as { repo_path?: string }
                  const eventRepoPath = p.repo_path ? getDirectory(p.repo_path) : ""
                  const currentRepoPath = getDirectory(device.directory)
                  if (eventRepoPath !== currentRepoPath) break
                  refreshVcs(1000)
                  summaryChanged = true
                  break
                }
                case "host.git.status.changed": {
                  const p = payload.properties as { repo_path?: string }
                  const eventRepoPath = p.repo_path ? getDirectory(p.repo_path) : ""
                  const currentRepoPath = getDirectory(device.directory)
                  if (eventRepoPath !== currentRepoPath) break
                  refreshVcs()
                  summaryChanged = true
                  break
                }
                case "host.git.remote.changed": {
                  const p = payload.properties as { repo_path?: string; branch?: string; old_head?: string; new_head?: string }
                  const eventRepoPath = p.repo_path ? getDirectory(p.repo_path) : ""
                  const currentRepoPath = getDirectory(device.directory)
                  if (eventRepoPath !== currentRepoPath) break
                  refreshVcs()
                  summaryChanged = true
                  break
                }
                case "host.git.stash.changed": {
                  const p = payload.properties as { repo_path?: string }
                  const eventRepoPath = p.repo_path ? getDirectory(p.repo_path) : ""
                  const currentRepoPath = getDirectory(device.directory)
                  if (eventRepoPath !== currentRepoPath) break
                  refreshVcs()
                  summaryChanged = true
                  break
                }
                // ── agent.runtime.restarted: server-driven, triggers rebootstrap for all workspaces ──
                case "agent.runtime.restarted": {
                  // Emitted after new agent is fully initialized; brief delay for stability
                  setTimeout(rebootstrap, 500)
                  break
                }
              }
              if (summaryChanged && props.workspaceId) {
                scheduleSummarySync()
              }
              dispatch(payload)
            })
          }
          if (!signal.aborted) {
            streamFailed()
          }
        } catch (e) {
          disarmAliveTimer()
          if ((e as any)?.name === "AbortError") return
          streamFailed()
        }
      }
      void readLoop()
    } catch (e) {
      disarmAliveTimer()
      if ((e as any)?.name === "AbortError") return
      streamFailed()
    }
  }

  const onVisibilityChange = () => {
    if (!document.hidden) void runWatchdogSweep()
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
  watchdogTimer = setInterval(() => { void runWatchdogSweep() }, WATCHDOG_INTERVAL_MS)

  onCleanup(() => {
    streamDisposed = true
    streamAbort?.abort()
    streamAbort = undefined
    disarmAliveTimer()
    clearDebounceTimers()
    stopWatchdog()
    document.removeEventListener("visibilitychange", onVisibilityChange)
    if (props.workspaceId) clearSummary(props.workspaceId)
  })

  const projectValue = createMemo(() => ({
    id: device.directory,
    worktree: device.directory,
    name: undefined as string | undefined,
    time: { created: Date.now(), updated: Date.now() },
  }))

  const value: DeviceWorkspaceValue = {
    get data() { return store },
    ready: () => store.status !== "loading",
    agentAvailable: () => store.agentAvailable,
    get project() { return projectValue() },
    session: {
      get: getSession,
      fetch: fetchSessions,
      remove: deleteSession,
      removeLocal: removeSessionLocal,
      patch: patchSession,
      setStatus: setSessionStatus,
      setQuestions: (q: Record<string, QuestionRequest[]>) => setStore("questions", reconcile(q)),
      setPermissions: (p: Record<string, PermissionRequest[]>) => setStore("permissions", reconcile(p)),
      removePermission,
      removeQuestion,
      clearUnread: (id: string) => {
        if (!store.unread[id]) return
        batch(() => {
          setStore("unread", produce((draft) => { delete draft[id] }))
          if (props.workspaceId) {
            syncSummary(props.workspaceId, {
              vcs: store.vcs,
              sessionStatus: store.sessionStatus,
              questions: store.questions,
              permissions: store.permissions,
              hasUnreadSession: store.session.some((s) => !s.parentID && store.unread[s.id]),
            })
          }
        })
      },
    },
    command: { load: loadCommands },
    vcs: { load: loadVcs },
    subscribe,
    directory: device.directory,
    workspaceId: props.workspaceId,
    proxyError,
    autoAccept,
    restartAgent,
    restarting,
  }

  return <DeviceWorkspaceContext.Provider value={value}>{props.children}</DeviceWorkspaceContext.Provider>
}
