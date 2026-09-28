import { Show, createMemo, createSignal, createEffect, on, onCleanup, batch, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore, produce } from "solid-js/store"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { DataProvider } from "@opencode-ai/ui/context"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { File } from "@opencode-ai/ui/file"
import { useSessionChat } from "@/context/session-chat"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"

import { NewSessionView } from "@/components/session/session-new-view"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { SessionComposerRegion } from "@/pages/session/composer/session-composer-region"
import { createDeviceSessionComposerState } from "@/pages/session/composer/device-session-composer-state"
import { createScrollSpy } from "@/pages/session/scroll-spy"
import type {
  Message,
  Part,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { Path } from "@opencode-ai/sdk/v2/client"
import { legacyProvider } from "@/utils/legacy-provider"
import { DeviceSessionProvider } from "@/context/device-session"
import { DeviceSessionViewHeader, type HeaderState } from "./device-session-view-header"
import { env } from "@/lib/env"

const busySinceMap = new Map<string, number>()
const PAGE_SIZE = 20

function PromptSeeder(props: { seed?: string }) {
  const prompt = usePrompt()
  const chat = useSessionChat()
  let seeded = false
  createEffect(() => {
    if (seeded) return
    const seed = props.seed
    if (!seed) return
    if (!prompt.ready()) return
    if (!chat.model.current() || !chat.agent.current()) return
    if (prompt.dirty()) {
      seeded = true
      return
    }
    seeded = true
    prompt.set([{ type: "text", content: seed, start: 0, end: seed.length }], seed.length)
  })
  return null
}

export function DeviceSessionView(props: {
  sessionID?: string
  createdSessionID?: () => string | undefined
  title?: () => string | undefined
  promptSeed?: string
  hiddenSeed?: string
  onSessionCreated?: (input: { sessionID: string; title?: string }) => void
  onClose?: () => void
  header?: (state: HeaderState) => JSX.Element
  inputOnly?: boolean
}) {
  const chat = useSessionChat()
  const language = useLanguage()

  let snapFrame: number | undefined

  const sid = createMemo(() => props.createdSessionID?.() ?? props.sessionID)

  const [viewingStack, setViewingStack] = createSignal<{ id: string; name: string }[]>([])

  chat.setOnSessionCreated((input) => queueMicrotask(() => props.onSessionCreated?.(input)))
  chat.setNavigateBack(() => setViewingStack((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev)))
  const [phase, setPhase] = createStore<Record<string, "loading" | "ready" | "error">>({})
  createEffect((prev: string[]) => {
    const stack = viewingStack()
    const currentIds = stack.map((e) => e.id)
    if (prev.length > currentIds.length) {
      batch(() => {
        setPhase(
          produce((draft: Record<string, "loading" | "ready" | "error">) => {
            const removed = prev.filter((id) => !currentIds.includes(id))
            for (const id of removed) delete draft[id]
          }),
        )
      })
    }
    return currentIds
  }, [] as string[])

  const containerRef = (el: HTMLDivElement) => {
    el.addEventListener(
      "click",
      (e) => {
        const target = e.target as HTMLElement
        const anchor = target.closest("a")
        if (!anchor) return
        const href = anchor.getAttribute("href")
        if (!href?.startsWith("#subagent-")) return
        e.preventDefault()
        e.stopPropagation()
        const id = href.slice("#subagent-".length)
        const name = anchor.textContent?.trim() || id.slice(0, 8)
        setViewingStack((prev) => [...prev, { id, name }])
      },
      true,
    )
  }

  const isNew = createMemo(() => !props.createdSessionID?.() && !props.sessionID)

  const rootSessionID = sid

  const mobileUrl = createMemo(() => {
    const host = `${env.MOBILE_HOST}${env.BASE_PATH ? `${env.BASE_PATH}` : ""}`
    if (!host) return ""
    const wsId = chat.workspaceId()
    const sid = rootSessionID()
    if (!wsId || !sid) return ""
    return `${host}/m/workspace/${wsId}?session=${sid}`
  })
  const viewingSessionID = createMemo(() => {
    const stack = viewingStack()
    return stack.length > 0 ? stack[stack.length - 1].id : undefined
  })
  const currentSessionID = createMemo(() => viewingSessionID() ?? rootSessionID())

  createEffect(() => {
    chat.setActiveSession(currentSessionID())
  })

  const effectiveMessages = createMemo(() => {
    const cid = currentSessionID()
    if (!cid) return [] as Message[]
    return chat.messages(cid)
  })

  const effectiveStatus = createMemo(() => {
    const cid = currentSessionID()
    if (cid) return chat.sessionStatus(cid)
    return ({ type: "idle" } as SessionStatus)
  })

  const isWorking = createMemo(() => {
    const t = effectiveStatus()?.type
    return t === "busy" || t === "retry" || t === "compacting"
  })

  const busySince = createMemo(() => {
    const cid = currentSessionID()
    if (!cid || !isWorking()) return undefined
    let t = busySinceMap.get(cid)
    if (t === undefined) {
      t = Date.now()
      busySinceMap.set(cid, t)
    }
    return t
  })

  createEffect(() => {
    const cid = currentSessionID()
    if (!cid) return
    if (!isWorking()) {
      busySinceMap.delete(cid)
    }
  })

  const effectiveParts = createMemo(() => {
    return chat.parts()
  })

  createEffect(
    on(currentSessionID, (id) => {
      if (!id) return
      const cached = chat.messages(id)
      setPhase(id, cached?.length ? "ready" : "loading")
      Promise.all([
        chat.loadMessages(id),
        chat.loadTodo(id),
      ])
        .then(() => {
          if (currentSessionID() === id) setPhase(id, "ready")
        })
        .catch(() => {
          if (currentSessionID() === id && phase[id] !== "ready") setPhase(id, "error")
        })
    }),
  )

  onCleanup(() => {
    if (snapFrame !== undefined) cancelAnimationFrame(snapFrame)
  })

  const composer = createDeviceSessionComposerState({
    chat,
    sessionID: currentSessionID,
    todos: () => {
      const cid = currentSessionID()
      return cid ? chat.todos(cid) : []
    },
    isAutoAccepting: () => chat.autoAccept.enabled(),
    enableAutoAccept: () => chat.autoAccept.enable(),
  })

  const [snap, setSnap] = createSignal(true)

  const done = createMemo(() => {
    const id = currentSessionID()
    if (!id) return false
    if (viewingSessionID()) return phase[id] === "ready" || phase[id] === "error"
    return !!chat.sessions().find((s) => s.id === id) && !chat.historyLoading(id)
  })

  const ready = createMemo(() => {
    const id = currentSessionID()
    if (!id) return false
    if (viewingSessionID()) return phase[id] === "ready"
    return !!chat.sessions().find((s) => s.id === id) && !chat.historyLoading(id)
  })

  const messagesLoading = createMemo(() => {
    if (isWorking()) return false
    if (isNew()) return false
    const id = currentSessionID()
    if (!id) return false
    const p = phase[id]
    return p !== "ready" && p !== "error" && effectiveMessages().length === 0
  })

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  const scrollSpy = createScrollSpy({
    onActive: () => {},
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0

  let scrollGesture = 0
  const scrollGestureWindowMs = 250
  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return
    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return
    scrollGesture = Date.now()
  }
  const hasScrollGesture = () => Date.now() - scrollGesture < scrollGestureWindowMs

  const enrichedMessages = createMemo(() => {
    const raw = effectiveMessages()
    if (!raw || raw.length === 0) return raw ?? []
    const parts = effectiveParts()
    const seen = new Set<string>()
    const deduped = raw.filter((m) => {
      if (seen.has(m.id)) return false
      seen.add(m.id)
      return true
    })
    const userIDs = new Set<string>()
    for (const m of deduped) {
      if (m.role === "user") userIDs.add(m.id)
    }
    const parentIDs = new Set<string>()
    for (const m of deduped) {
      if (m.role === "assistant" && (m as any).parentID) parentIDs.add((m as any).parentID)
    }
    let orphanID: string | undefined
    let orphanCreated = false
    const enriched: any[] = []
    for (const m of deduped) {
      if (m.role === "assistant" && m.parentID && !userIDs.has(m.parentID)) {
        if (!parts?.[m.parentID]?.length) {
          enriched.push(m)
          continue
        }
        if (!orphanCreated || m.parentID !== orphanID) {
          orphanCreated = false
        }
        if (!orphanCreated) {
          const orphan = {
            id: m.parentID,
            sessionID: currentSessionID() ?? "",
            role: "user",
            synthetic: true,
            time: { created: m.time?.created ?? 0 },
          }
          orphanID = m.parentID
          enriched.push(orphan)
          userIDs.add(m.parentID)
          orphanCreated = true
        }
        if (m.parentID !== orphanID) {
          enriched.push({ ...m, parentID: orphanID })
          continue
        }
      }
      enriched.push(m)
    }
    return enriched
  })

  createEffect(on(currentSessionID, () => setSnap(true), { defer: true }))

  createEffect(() => {
    if (!snap()) return
    if (!scroller) return
    if (!done()) return
    if (snapFrame !== undefined) cancelAnimationFrame(snapFrame)
    snapFrame = requestAnimationFrame(() => {
      snapFrame = undefined
      if (ready()) resumeScroll()
      setSnap(false)
    })
  })

  const [visibleCounts, setVisibleCounts] = createStore<Record<string, number>>({})
  const visibleCount = createMemo(() => {
    const cid = currentSessionID()
    return cid ? visibleCounts[cid] ?? PAGE_SIZE : PAGE_SIZE
  })
  const totalCount = createMemo(() => enrichedMessages().length)
  const paginatedMessages = createMemo(() => {
    const all = enrichedMessages()
    const n = visibleCount()
    if (n >= all.length) return all
    return all.slice(-n)
  })
  const serverHistoryMore = createMemo(() => {
    const cid = currentSessionID()
    return !!cid && chat.historyMore(cid)
  })
  const historyMore = createMemo(() => totalCount() > visibleCount() || serverHistoryMore())
  const historyLoading = createMemo(() => {
    const cid = currentSessionID()
    return !!cid && chat.historyLoading(cid)
  })
  const turnStart = createMemo(() => Math.max(0, totalCount() - visibleCount()))
  const onLoadEarlier = async () => {
    const cid = currentSessionID()
    if (!cid) return
    if (totalCount() > visibleCount()) {
      setVisibleCounts(cid, (visibleCounts[cid] ?? PAGE_SIZE) + PAGE_SIZE)
      return
    }
    if (!chat.historyMore(cid)) return
    await chat.historyLoadMore(cid)
    setVisibleCounts(cid, (visibleCounts[cid] ?? PAGE_SIZE) + PAGE_SIZE)
  }

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    scrollSpy.setContainer(el)
  }

  const resumeScroll = () => {
    autoScroll.forceScrollToBottom()
  }

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)
      if (next === dockHeight) return
      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? snap() ||
          !autoScroll.userScrolled() ||
          el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false
      dockHeight = next
      if (stick) autoScroll.forceScrollToBottom()
    },
  )

  const anchor = (id: string) => `message-${id}`

  const dataProps = createMemo(() => {
    const cid = currentSessionID()
    const parts = effectiveParts()
    const status = chat.workspaceStatus()
    return {
      status: (status === "unavailable" || status === "loading" ? "loading" : "complete") as "complete" | "loading",
      agent: chat.agents(),
      agentRuntimes: [] as unknown[],
      command: chat.commands(),
      project: "",
      projectMeta: undefined as any,
      icon: undefined as string | undefined,
      provider: legacyProvider(chat.providerCaps()),
      path: { directory: chat.directory() } as Path,
      session: chat.sessions(),
      sessionTotal: chat.sessionTotal(),
      session_status: {
        ...Object.fromEntries(chat.sessions().map((s) => [s.id, chat.sessionStatus(s.id)])),
        ...(cid ? { [cid]: effectiveStatus() } : {}),
        "": effectiveStatus(),
        undefined: effectiveStatus(),
      } as Record<string, SessionStatus>,
      todo: { [cid ?? ""]: chat.todos(cid ?? "") } as Record<string, Todo[]>,
      permission: chat.permissions(),
      question: chat.questions(),
      mcp: {} as Record<string, any>,
      lsp: [] as any[],
      vcs: chat.vcs(),
      limit: 50,
      message: { [cid ?? ""]: enrichedMessages(), "": enrichedMessages(), undefined: enrichedMessages() } as Record<
        string,
        Message[]
      >,
      part: parts as Record<string, Part[]>,
      partProgress: chat.partProgress(),
    }
  })

  const headerState: HeaderState = {
    viewingStack,
    setViewingStack,
    isNew,
    userScrolled: () => autoScroll.userScrolled(),
    resumeScroll,
    rootSessionID,
    mobileUrl,
    viewingSessionID,
    title: () => props.title?.(),
    onClose: () => props.onClose?.(),
  }

  return (
    <DeviceSessionProvider sessionID={sid()}>
            <PromptSeeder seed={props.promptSeed} />
              <DataProvider
                          data={dataProps()!}
                          directory={chat.directory()}
                          onNavigateToSession={(id: string) => {
                            const name = chat.findSessionName(id)
                            setViewingStack((prev) => [...prev, { id, name }])
                          }}
                          onSessionHref={(id: string) => `#subagent-${id}`}
                        >
                          <FileComponentProvider component={File}>
                            <div class="relative size-full flex flex-col" classList={{ "bg-background-base": !props.inputOnly, "overflow-hidden": !props.inputOnly }}>
                              {!props.inputOnly && (props.header ? props.header(headerState) : <DeviceSessionViewHeader state={headerState} />)}
                              <div ref={containerRef} class="flex-1 min-h-0 flex flex-col">
                                <div class="@container relative shrink-0 flex flex-col min-h-0 h-full flex-1" classList={{ "bg-background-stronger": !props.inputOnly }}>
                                  <Show when={!props.inputOnly}>
                                    <div class="flex-1 min-h-0 overflow-hidden">
                                      <Show
                                        when={!isNew()}
                                        fallback={<NewSessionView />}
                                      >
                                        <Show
                                          when={!messagesLoading()}
                                          fallback={
                                            <div class="flex h-full items-center justify-center">
                                              <div class="size-5 rounded-full border-2 border-border-base border-t-text-dimmed animate-spin" />
                                            </div>
                                          }
                                        >
                                          <MessageTimeline
                                        hideHeader
                                        mobileChanges={false}
                                        mobileFallback={<div />}
                                        scroll={{ overflow: false, bottom: true }}
                                        onResumeScroll={resumeScroll}
                                        setScrollRef={setScrollRef}
                                        onScheduleScrollState={() => {}}
                                        onAutoScrollHandleScroll={autoScroll.handleScroll}
                                        onMarkScrollGesture={markScrollGesture}
                                        hasScrollGesture={hasScrollGesture}
                                        isDesktop={true}
                                        onScrollSpyScroll={scrollSpy.onScroll}
                                        onTurnBackfillScroll={() => {}}
                                        onAutoScrollInteraction={autoScroll.handleInteraction}
                                        centered={true}
                                        setContentRef={(el) => {
                                          content = el
                                          autoScroll.contentRef(el)
                                        }}
                                        turnStart={turnStart()}
                                        historyMore={historyMore()}
                                        historyLoading={historyLoading()}
                                        onLoadEarlier={onLoadEarlier}
                                        renderedMessages={paginatedMessages() as any[]}
                                        anchor={anchor}
                                        onRegisterMessage={scrollSpy.register}
                                        onUnregisterMessage={scrollSpy.unregister}
                                      />
                                        </Show>
                                    </Show>
                                  </div>
                                  </Show>
                                  <Show when={chat.agentAvailable()}>
                                    <SessionComposerRegion
                                      state={composer}
                                      sessionID={currentSessionID}
                                      centered={!props.inputOnly}
                                      compact={props.inputOnly}
                                      inputRef={(el: HTMLDivElement) => {
                                        if (!el) return
                                        const handler = () => {
                                          const sid = rootSessionID()
                                          if (sid) chat.clearUnread(sid)
                                        }
                                        el.addEventListener("focusin", handler)
                                        el.addEventListener("pointerdown", handler)
                                      }}
                                      newSessionWorktree="main"
                                      hiddenSeed={() => props.hiddenSeed}
                                      onNewSessionWorktreeReset={() => {}}
                                      onSubmit={() => {
                                        resumeScroll()
                                        const sid = rootSessionID()
                                        if (sid) chat.clearUnread(sid)
                                      }}
                                      onResponseSubmit={resumeScroll}
                                      setPromptDockRef={(el) => {
                                        promptDock = el
                                      }}
                                      hideAttachButton
                                      hidePrompt={!!viewingSessionID()}
                                      working={isWorking()}
                                      busySince={busySince()}
                                    />
                                  </Show>
                                  <Show when={!chat.agentAvailable()}>
                                    <div class="shrink-0 w-full pb-3 flex justify-center items-center">
                                      <span class="text-12-regular text-text-weak">
                                        {language.t("workspace.device.offline")}
                                      </span>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </div>
                          </FileComponentProvider>
                        </DataProvider>
    </DeviceSessionProvider>
  )
}
