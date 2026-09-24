import { createMemo, createSignal, For, Match, onMount, onCleanup, Show, Switch, createEffect, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useParams, useSearchParams } from "@solidjs/router"
import { Toast } from "@opencode-ai/ui/toast"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { useFile } from "@/context/file"
import { useDiff, useTreePolling } from "@/context/device-file"
import { useDeviceWorkspace } from "@/context/device-workspace"
import { sessionTreeIDs } from "@/pages/session/composer/session-request-tree"
import { DeviceSessionStoreProvider } from "@/context/device-session"
import { PromptProvider } from "@/context/prompt"
import { SessionComposerRegistryProvider } from "@/context/session-composer-registry"
import { SessionTabProvider, useSessionTab } from "@/context/session-tab"
import { DeviceSessionView } from "./device-session-view"
import { DeviceSessionViewHeader } from "./device-session-view-header"
import { DeviceSessionChatProvider } from "@/context/device-session-chat"
import { useConversationAdapter } from "@/context/device-adapter"
import { TerminalTab } from "./terminal-tab"
import { useDeviceTerminal } from "@/context/device-terminal"
import { ContentTabContext, useContentTabs, type ContentTab } from "@/context/content-tabs"
import { useLayout } from "@/context/layout"
import { FilePreviewTab } from "./file-preview-tab"
import { DiffPreviewTab } from "./diff-preview-tab"
import { workspaceKey } from "@/lib/workspace-key"
import { shouldRestore, activeSession, sessionTabsToClose } from "./workspace-content-layout-sync"
import FileTree from "@/components/file-tree"
import type { FileNode } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { useWorkspace } from "../context"
import { useWorkspaceVisible } from "./layout"
import { filePreviewConfig } from "../lib/file-preview-config"
import { MessageSquare, FolderOpen, GitBranch, Terminal } from "lucide-solid"
import { SessionActionMenuItems } from "./session-action-menu"
import { HoverScrollText } from "./hover-scroll-text"

let newSessionCounter = 0

let newTerminalCounter = 0

const SESSION_TAB_ICON = "bubble-5"

function hasPendingInteraction(
  sessions: { id: string; parentID?: string }[],
  questions: Record<string, unknown[]>,
  permissions: Record<string, unknown[]>,
  sessionID?: string,
): boolean {
  if (!sessionID) return false
  const treeIds = sessionTreeIDs(sessions as any, sessionID)
  return treeIds.some((id) => (questions[id]?.length ?? 0) > 0 || (permissions[id]?.length ?? 0) > 0)
}

function sessionGroup(session: { time?: { updated?: number; created?: number } }) {
  const now = Date.now()
  const startOfDay = new Date(now).setHours(0, 0, 0, 0)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
  const t = session.time?.updated ?? session.time?.created ?? 0
  return t >= startOfDay ? "today" : t >= sevenDaysAgo ? "thisWeek" : "older"
}

function DiffStatusBadge(props: { status: string }) {
  const label = () => {
    switch (props.status) {
      case "modified": return "M"
      case "deleted": return "D"
      case "renamed": return "R"
      case "untracked": return "?"
      default: return "?"
    }
  }
  const bg = () => {
    switch (props.status) {
      case "modified": return "hsl(25 95% 53%)"
      case "deleted": return "hsl(0 84% 60%)"
      case "renamed": return "hsl(199 89% 48%)"
      case "untracked": return "hsl(220 9% 60%)"
      default: return "hsl(220 9% 60%)"
    }
  }
  return (
    <span
      class="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] rounded-[3px]"
      style={{ "background-color": bg(), color: "#ffffff", "font-weight": 700 }}
    >
      {label()}
    </span>
  )
}

function TabIcon(props: { tab: ContentTab }) {
  return (() => {
    if (props.tab.kind === "diff") {
      return <DiffStatusBadge status={(props.tab.meta as any)?.status ?? "modified"} />
    }
    if (props.tab.kind === "file") {
      const path = (props.tab.meta as any)?.path as string | undefined
      return <FileIcon node={{ path: path ?? "", type: "file" }} class="size-4 shrink-0" />
    }
    return <Icon name={props.tab.icon as any ?? "file-tree"} size="small" class="shrink-0 text-text-weak" />
  })()
}

function PendingInteractionIcon() {
  return (
    <div class="shrink-0 flex items-center justify-center w-4 h-4 animate-bell" style={{ "transform-origin": "top center" }}>
      <Icon name="bell" size="small" style={{ color: "#ffa000" }} />
    </div>
  )
}

function WorkingIcon(props: { class?: string; classList?: Record<string, boolean>; title?: string }) {
  return (
    <div class="shrink-0 flex items-center justify-center w-4 h-4">
      <div
        class="size-3 rounded-full border border-t-transparent animate-spin"
        classList={props.classList}
        title={props.title}
      />
    </div>
  )
}

function SessionTabIcon(props: { tab: ContentTab }) {
  const dw = useDeviceWorkspace()
  const status = createMemo(() => {
    const id = props.tab.meta?.sessionID as string | undefined
    if (!id) return undefined
    return dw.data.sessionStatus[id]
  })
  const working = createMemo(() => {
    const t = status()?.type
    return t === "busy" || t === "retry" || t === "compacting"
  })
  const pending = createMemo(() => {
    const id = props.tab.meta?.sessionID as string | undefined
    return hasPendingInteraction(dw.data.session, dw.data.questions, dw.data.permissions, id)
  })
  const unread = createMemo(() => {
    const id = props.tab.meta?.sessionID as string | undefined
    if (!id) return false
    return !!dw.data.unread[id]
  })

  const tabStore = useContentTabs()
  const isActiveTab = createMemo(() => tabStore.activeId() === props.tab.id)

  return (
    <Show
      when={pending()}
      fallback={
        <Show when={working()} fallback={
          <Show when={unread()} fallback={<TabIcon tab={props.tab} />}>
            <span class="shrink-0 w-2 h-2 rounded-full bg-native-primary" />
          </Show>
        }>
          <WorkingIcon
            title={status()?.type === "retry" ? "retry" : status()?.type === "compacting" ? "compacting" : "busy"}
            classList={{
              "border-native-primary": isActiveTab(),
              "border-native-dim": !isActiveTab(),
            }}
          />
        </Show>
      }
    >
      <PendingInteractionIcon />
    </Show>
  )
}

function SessionTabAdapter(props: { tabId: string; sessionID?: string }) {
  const sessionTab = useSessionTab()
  const tabStore = useContentTabs()
  const title = createMemo(() => tabStore.tabs().find((t) => t.id === props.tabId)?.title)
  return (
    <DeviceSessionChatProvider>
      <DeviceSessionView
        sessionID={props.sessionID}
        createdSessionID={sessionTab.createdSessionID}
        title={title}
        onSessionCreated={sessionTab.replaceTab}
        onClose={() => tabStore.close(props.tabId)}
        header={(state) => <DeviceSessionViewHeader state={state} />}
      />
    </DeviceSessionChatProvider>
  )
}

function TabContent(props: { tab: ContentTab }) {
  return (
    <Switch>
      <Match when={props.tab.kind === "file"}>
        <FilePreviewTab tab={props.tab} />
      </Match>
      <Match when={props.tab.kind === "diff"}>
        <DiffPreviewTab tab={props.tab} />
      </Match>
      <Match when={props.tab.kind === "session"}>
        <SessionTabProvider tabId={props.tab.id} sessionID={(props.tab.meta as any)?.sessionID}>
          <SessionTabAdapter tabId={props.tab.id} sessionID={(props.tab.meta as any)?.sessionID} />
        </SessionTabProvider>
      </Match>
      <Match when={props.tab.kind === "terminal"}>
        <TerminalTab tab={props.tab} />
      </Match>
    </Switch>
  )
}

function ContentTabPanel() {
  const tabStore = useContentTabs()
  const terminal = useDeviceTerminal()
  const language = useLanguage()
  const layout = useLayout()
  const dw = useDeviceWorkspace()
  const visible = useWorkspaceVisible()

  const [contentId, setContentId] = createSignal(tabStore.activeId())
  createEffect(() => {
    const id = tabStore.activeId()
    if (id === contentId()) return
    const frame = requestAnimationFrame(() => setContentId(id))
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const handleTabSwitch = (e: KeyboardEvent) => {
    if (!visible()) return
    if (!e.ctrlKey) return
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return
    e.preventDefault()

    const tabs = tabStore.tabs()
    if (tabs.length <= 1) return

    const activeId = tabStore.activeId()
    const currentIdx = tabs.findIndex((t) => t.id === activeId)
    if (currentIdx === -1) return

    const nextIdx = e.key === "ArrowRight"
      ? (currentIdx + 1) % tabs.length
      : (currentIdx - 1 + tabs.length) % tabs.length

    tabStore.activate(tabs[nextIdx].id)
  }
  document.addEventListener("keydown", handleTabSwitch)
  onCleanup(() => document.removeEventListener("keydown", handleTabSwitch))

  const WELCOME_EXAMPLES = [
    "workspace.content.welcome.example.1",
    "workspace.content.welcome.example.2",
    "workspace.content.welcome.example.3",
    "workspace.content.welcome.example.4",
    "workspace.content.welcome.example.5",
    "workspace.content.welcome.example.6",
  ] as const

  const [exampleIdx, setExampleIdx] = createSignal(0)
  let exampleTimer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    exampleTimer = setInterval(() => {
      setExampleIdx((i) => (i + 1) % WELCOME_EXAMPLES.length)
    }, 10000)
  })
  onCleanup(() => { if (exampleTimer) clearInterval(exampleTimer) })

  const closeTab = (id: string) => {
    const tab = tabStore.tabs().find((t) => t.id === id)
    if (tab?.kind === "terminal") {
      const sessionId = (tab.meta as any)?.sessionId as string | undefined
      if (sessionId) terminal.close(sessionId)
    }
    tabStore.close(id)
  }

  return (
    <div class="flex-1 min-w-0 h-full flex flex-col">
      <Show
        when={tabStore.tabs().length > 0}
        fallback={
          <div class="flex-1 h-full flex flex-col items-center justify-center">
            <div class="flex flex-col items-center gap-24 w-full max-w-[720px] 2xl:max-w-[900px] px-6">
              <Show when={dw.agentAvailable()}>
                <div class="flex flex-col items-center gap-10 w-[80%]">
                  <h2 class="text-text-strong" style={{ "font-size": "36px", "font-weight": "700" }}>{language.t("workspace.content.welcome.title")}</h2>
                  <div class="h-6 flex items-center text-center">
                    <span class="text-14-regular text-text-weak transition-opacity duration-500">{language.t("workspace.content.welcome.examplePrefix")}{language.t(WELCOME_EXAMPLES[exampleIdx()])}</span>
                  </div>
                </div>
              </Show>
              <Show when={dw.agentAvailable()}>
                <div class="w-full">
                  <DeviceSessionChatProvider>
                    <DeviceSessionView
                      inputOnly
                      onSessionCreated={(input) => {
                        tabStore.open({
                          kind: "session",
                          title: input.title ?? language.t("command.session.new"),
                          icon: SESSION_TAB_ICON,
                          key: input.sessionID,
                          meta: { sessionID: input.sessionID },
                        })
                      }}
                    />
                  </DeviceSessionChatProvider>
                </div>
              </Show>
            </div>
          </div>
        }
      >
        <Tabs
          value={tabStore.activeId()}
          onChange={(id: string) => {
            tabStore.activate(id)
            const tab = tabStore.tabs().find((t) => t.id === id)
            const sid = tab?.kind === "session" ? (tab.meta?.sessionID as string | undefined) : undefined
            if (sid) {
              dw.session.clearUnread(sid)
            }
          }}
          class="h-full flex flex-col"
        >
          <div class="h-[41px] shrink-0 flex items-center border-b">
            <div class="shrink-0 flex items-center px-2">
              <Tooltip value={language.t(layout.fileTree.opened() ? "workspace.sidebar.collapse" : "workspace.sidebar.expand")} placement="bottom">
                <IconButton
                  icon={layout.fileTree.opened() ? "chevron-left" : "chevron-right"}
                  variant="ghost"
                  iconSize="small"
                  onClick={layout.fileTree.toggle}
                  aria-label={language.t(layout.fileTree.opened() ? "workspace.sidebar.collapse" : "workspace.sidebar.expand")}
                />
              </Tooltip>
            </div>
            <Tabs.List class="flex-1 min-w-0 h-full border-l [&::after]:border-b-0 overflow-x-auto scrollbar-none" onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY }}>
              <For each={tabStore.tabs()}>
                {(tab) => {
                  const selected = createMemo(() => tabStore.activeId() === tab.id)
                  return (
                    <Tabs.Trigger
                      value={tab.id}
                      class="group h-full w-[160px] shrink-0 !border-b-0 [&>[data-slot=tabs-trigger]]:h-full [&>[data-slot=tabs-trigger]]:w-full [&>[data-slot=tabs-trigger]]:px-2 [&>[data-slot=tabs-trigger]]:gap-1.5 [&>[data-slot=tabs-trigger]]:justify-start flex items-center gap-1.5 text-13-regular text-text-weak hover:text-text-base transition-colors relative"
                      classList={{
                        "!bg-background-base !border-b before:absolute before:top-0 before:left-0 before:right-0 before:h-[2px] before:bg-icon-strong-base text-text-base": selected(),
                        "!bg-background-weak": !selected(),
                      }}
                    >
                      <Show when={tab.kind === "session"} fallback={<TabIcon tab={tab} />}>
                        <SessionTabIcon tab={tab} />
                      </Show>
                      <span class="truncate flex-1 min-w-0 text-left">{tab.title}</span>
                      <button
                        class="flex items-center justify-center size-5 rounded-[4px] w-0 overflow-hidden group-hover:w-5 shrink-0 opacity-0 group-hover:opacity-100 transition-[width,opacity] hover:bg-[var(--surface-base-hover)] hover:ring-1 hover:ring-border"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(tab.id)
                        }}
                      >
                        <Icon name={"close-small" as any} size="small" class="text-text-weak" />
                      </button>
                    </Tabs.Trigger>
                  )
                }}
              </For>
            </Tabs.List>
            <div class="shrink-0 flex items-center px-2">
              <Tooltip value={language.t("workspace.content.closeAll")} placement="bottom">
                <IconButton
                  icon="trash"
                  variant="ghost"
                  iconSize="small"
                  onClick={() => {
                    for (const t of tabStore.tabs()) {
                      if (t.kind === "terminal") {
                        const sid = t.meta?.sessionId as string | undefined
                        if (sid) terminal.close(sid)
                      }
                    }
                    tabStore.closeAll()
                  }}
                  aria-label={language.t("workspace.content.closeAll")}
                />
              </Tooltip>
            </div>
          </div>
          <For each={tabStore.tabs()}>
            {(tab) => (
              <Show when={contentId() === tab.id}>
                <Tabs.Content value={tab.id} class="flex-1 min-h-0">
                  <TabContent tab={tab} />
                </Tabs.Content>
              </Show>
            )}
          </For>
        </Tabs>
      </Show>
    </div>
  )
}

function FileTreeWithTabs(props: { path: string }) {
  const tabStore = useContentTabs()
  const file = useFile()
  const diff = useDiff()

  const handleFileClick = (node: FileNode) => {
    if (node.type === "directory") return
    const path = node.path ?? node.absolute
    if (!path) return
    tabStore.open({
      kind: "file",
      key: path,
      title: node.name,
      icon: "file-tree",
      meta: { path },
    })
    void file.load(path, { limit: filePreviewConfig.initialPreviewLines })
  }

  const kinds = createMemo(() => {
    const s = diff.state()
    const out = new Map<string, "add" | "del" | "mix">()
    const fill = (files: { path: string; status: string }[]) => {
      for (const f of files) {
        if (f.status === "deleted") continue
        out.set(file.normalize(f.path).replaceAll("\\", "/"), f.status === "untracked" || f.status === "added" ? "add" : "mix")
      }
    }
    fill(s.untrackedFiles)
    fill(s.unstagedFiles)
    fill(s.stagedFiles)

    for (const [path, kind] of [...out]) {
      const parts = path.split("/")
      for (let i = parts.length - 1; i > 0; i--) {
        const dir = parts.slice(0, i).join("/")
        if (kind === "mix") out.set(dir, "mix")
        else if (!out.has(dir)) out.set(dir, "add")
      }
    }
    return out
  })

  return <FileTree path={props.path} onFileClick={handleFileClick} kinds={kinds()} />
}

type SidebarSection = "sessions" | "files" | "diffs"

function ContentSidebar(props: { directory: string; autoExpandGroup?: () => { group: string; nonce: number } | undefined }) {
  const language = useLanguage()
  const tabStore = useContentTabs()
  const terminal = useDeviceTerminal()
  const dw = useDeviceWorkspace()
  const work = useWorkspace()
  const file = useFile()
  const diff = useDiff()
  const treePolling = useTreePolling()
  const adapter = useConversationAdapter()
  const [sidebarSearch] = useSearchParams<{ session?: string }>()
  const [active, setActive] = createSignal<SidebarSection | undefined>("sessions")
  const [diffGroups, setDiffGroups] = createSignal<Record<string, boolean>>({})
  const [groups, setGroups] = createSignal<Record<string, boolean>>({ older: true })
  const now = Date.now()

  const sortedSessions = createMemo(() => {
    const sessions = dw.data.session
    return sessions
      .filter((s) => !s.parentID)
      .slice()
      .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
  })

  type SessionGroup = { key: string; label: string; sessions: Session[] }

  const sessionGroups = createMemo<SessionGroup[]>(() => {
    const groups: SessionGroup[] = [
      { key: "today", label: language.t("workspace.session.group.today"), sessions: [] },
      { key: "thisWeek", label: language.t("workspace.session.group.thisWeek"), sessions: [] },
      { key: "older", label: language.t("workspace.session.group.older"), sessions: [] },
    ]
    for (const s of sortedSessions()) {
      const key = sessionGroup(s)
      if (key === "today") groups[0].sessions.push(s)
      else if (key === "thisWeek") groups[1].sessions.push(s)
      else groups[2].sessions.push(s)
    }
    return groups.filter((g) => g.sessions.length > 0)
  })

  const isWorking = (id: string) => {
    const s = dw.data.sessionStatus[id]
    return s?.type === "busy" || s?.type === "retry" || s?.type === "compacting"
  }

  const timeLabel = (timestamp: number) => {
    if (!timestamp) return ""
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return language.t("workspace.session.time.justNow")
    if (minutes < 60) return language.t("workspace.session.time.minutes", { count: minutes })
    const hours = Math.floor(diff / 3_600_000)
    if (hours < 24) return language.t("workspace.session.time.hours", { count: hours })
    const days = Math.floor(diff / 86_400_000)
    if (days < 7) return language.t("workspace.session.time.days", { count: days })
    return new Intl.DateTimeFormat(language.locale() === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(timestamp))
  }

  const openSession = (session: Session) => {
    dw.session.clearUnread(session.id)
    const existing = tabStore.tabs().find((t) => t.kind === "session" && t.meta?.sessionID === session.id)
    if (existing) {
      tabStore.activate(existing.id)
      return
    }
    tabStore.open({
      kind: "session",
      key: session.id,
      title: session.title || language.t("command.session.new"),
      icon: SESSION_TAB_ICON,
      meta: { sessionID: session.id },
    })
  }

  createEffect(() => {
    if (dw.data.status !== "ready") return
    const live = new Set(dw.data.session.map((s) => s.id))
    for (const sid of live) {
      tabStore.confirmSession(sid)
    }
    // Never prune the session the URL currently points at — a deep-linked
    // session can live outside this workspace's directory and so won't appear
    // in `live`; closing it would drop the session being viewed.
    const ids = sessionTabsToClose(tabStore.tabs(), live, sidebarSearch.session, tabStore.isPendingSession)
    if (ids.length === 0) return
    ids.forEach(tabStore.close)
  })

  createEffect(() => {
    if (active() === "files") treePolling.start()
    else treePolling.stop()
  })

  createEffect(() => {
    if (active() === "diffs" || active() === "files") diff.scheduler.start()
    else diff.scheduler.stop()
  })

  createEffect(() => {
    const event = props.autoExpandGroup?.()
    if (event) {
      setGroups((prev) => ({ ...prev, [event.group]: false }))
    }
  })

  const statusLabel = (status: string) => {
    switch (status) {
      case "modified": return "M"
      case "deleted": return "D"
      case "renamed": return "R"
      case "untracked": return "?"
      default: return "?"
    }
  }

  const statusBadgeStyle = (status: string) => {
    switch (status) {
      case "modified": return { "background-color": "hsl(25 95% 53%)" }
      case "deleted": return { "background-color": "hsl(0 84% 60%)" }
      case "renamed": return { "background-color": "hsl(199 89% 48%)" }
      case "untracked": return { "background-color": "hsl(220 9% 60%)" }
      default: return { "background-color": "hsl(220 9% 60%)" }
    }
  }

  const select = (section: SidebarSection) => {
    setActive(section)
  }

  return (
    <div class="flex flex-col h-full border-r">
      <div class="h-[41px] shrink-0 flex items-center gap-0.5 px-2 border-b">
        <Show when={!work.sidebarOpened()}>
          <Tooltip value={language.t("workspace.sidebar.expand")} placement="bottom">
            <IconButton
              icon="chevron-right"
              variant="ghost"
              iconSize="small"
              onClick={work.openSidebar}
              aria-label={language.t("workspace.sidebar.expand")}
            />
          </Tooltip>
        </Show>
        <Tooltip value={language.t("workspace.content.section.sessions")} placement="bottom">
          <button
            class="flex items-center justify-center size-7 rounded-[4px] transition-colors"
            classList={{
              "bg-[var(--surface-base-hover)]/80 ring-1 ring-border text-text-base": active() === "sessions",
              "hover:bg-[var(--surface-base-hover)] hover:ring-1 hover:ring-border text-text-weak": active() !== "sessions",
            }}
            onClick={() => select("sessions")}
            aria-label={language.t("workspace.content.section.sessions")}
          >
            <MessageSquare class="size-4" />
          </button>
        </Tooltip>
        <Tooltip value={language.t("workspace.content.section.files")} placement="bottom">
          <button
            class="flex items-center justify-center size-7 rounded-[4px] transition-colors"
            classList={{
              "bg-[var(--surface-base-hover)]/80 ring-1 ring-border text-text-base": active() === "files",
              "hover:bg-[var(--surface-base-hover)] hover:ring-1 hover:ring-border text-text-weak": active() !== "files",
            }}
            onClick={() => select("files")}
            aria-label={language.t("workspace.content.section.files")}
          >
            <FolderOpen class="size-4" />
          </button>
        </Tooltip>
        <Tooltip value={language.t("workspace.content.section.changes")} placement="bottom">
          <button
            class="flex items-center justify-center size-7 rounded-[4px] transition-colors"
            classList={{
              "bg-[var(--surface-base-hover)]/80 ring-1 ring-border text-text-base": active() === "diffs",
              "hover:bg-[var(--surface-base-hover)] hover:ring-1 hover:ring-border text-text-weak": active() !== "diffs",
            }}
            onClick={() => select("diffs")}
            aria-label={language.t("workspace.content.section.changes")}
          >
            <GitBranch class="size-4" />
          </button>
        </Tooltip>
        <Tooltip value={language.t("command.terminal.new")} placement="bottom">
          <button
            class="flex items-center justify-center size-7 rounded-[4px] transition-colors hover:bg-[var(--surface-base-hover)] hover:ring-1 hover:ring-border text-text-weak"
            onClick={() => {
              newTerminalCounter++
              const pendingKey = `pending-${newTerminalCounter}`
              tabStore.open({
                kind: "terminal",
                key: pendingKey,
                title: language.t("command.terminal.new"),
                icon: "terminal",
                meta: { sessionId: undefined },
              })
              terminal.new().then((sessionId) => {
                if (!sessionId) {
                  return
                }
                tabStore.replace(tabStore.makeTabId("terminal", pendingKey), {
                  kind: "terminal",
                  key: sessionId,
                  title: `Terminal`,
                  icon: "terminal",
                  meta: { sessionId },
                })
              })
            }}
            aria-label={language.t("command.terminal.new")}
          >
            <Terminal class="size-4" />
          </button>
        </Tooltip>
        <div class="flex-1" />
        <button
          class="flex items-center gap-1 h-7 px-2 rounded-[4px] text-[12px] font-medium text-text-base ring-1 ring-border hover:bg-[var(--surface-base-hover)] transition-colors cursor-pointer"
          onClick={() => {
            newSessionCounter++
            tabStore.open({
              kind: "session",
              key: `new-${newSessionCounter}`,
              title: language.t("command.session.new"),
              icon: SESSION_TAB_ICON,
              meta: { sessionID: undefined },
            })
          }}
          aria-label={language.t("workspace.content.newSession")}
        >
          <Icon name="plus-small" size="small" />
          <span>{language.t("workspace.content.newSession")}</span>
        </button>
      </div>

      <div class="flex-1 min-h-0 flex flex-col">
        <Show when={active()}>
          <div class="flex-1 min-h-0 overflow-y-auto thin-scrollbar">
            <Show when={active() === "sessions"}>
              <Show when={dw.data.status === "loading"} fallback={
                <Show when={sessionGroups().length > 0} fallback={
                  <div class="px-3 py-2 text-12-regular text-text-weak">
                    {language.t("workspace.emptySessions")}
                  </div>
                }>
                  <div class="px-1.5 py-1">
                    <For each={sessionGroups()}>
                      {(group) => {
                        const collapsed = createMemo(() => !!groups()[group.key])
                        return (
                          <>
                            <button
                              class="flex items-center gap-1 w-full px-1.5 pt-1.5 pb-0.5 text-[12px] font-[600] text-native-muted tracking-wide uppercase cursor-pointer hover:text-native-foreground transition-colors"
                              onClick={() => setGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }))}
                            >
                              <Icon name={collapsed() ? "chevron-right" : "chevron-down"} size="small" class="shrink-0" />
                              <span class="truncate">{group.label}</span>
                            </button>
                            <Show when={!collapsed()}>
                              <For each={group.sessions}>
                                {(session) => {
                                  const isActive = createMemo(() => {
                                    const current = tabStore.active()
                                    return current?.kind === "session" && current?.meta?.sessionID === session.id
                                  })
                                  return (
                                    <div
                                      data-session-row=""
                                      class="group/s flex items-center gap-1.5 h-9 px-1.5 text-12-regular rounded-md cursor-pointer transition-colors duration-150"
                                      classList={{
                                        "bg-native-primary-soft text-native-foreground": isActive(),
                                        "text-native-muted hover:bg-native-hover hover:text-native-foreground": !isActive(),
                                      }}
                                      onClick={() => openSession(session)}
                                    >
                                      <Show when={hasPendingInteraction(dw.data.session, dw.data.questions, dw.data.permissions, session.id)}>
                                        <PendingInteractionIcon />
                                      </Show>
                                      <Show when={!hasPendingInteraction(dw.data.session, dw.data.questions, dw.data.permissions, session.id) && isWorking(session.id)}>
                                        <WorkingIcon
                                          classList={{
                                            "border-native-primary": isActive(),
                                            "border-native-dim": !isActive(),
                                          }}
                                        />
                                      </Show>
                                      <Show when={!hasPendingInteraction(dw.data.session, dw.data.questions, dw.data.permissions, session.id) && !isWorking(session.id) && !!dw.data.unread[session.id]}>
                                        <span class="shrink-0 w-2 h-2 rounded-full bg-native-primary" />
                                      </Show>
                                      <HoverScrollText text={session.title || language.t("command.session.new")} />
                                          <span
                                            aria-hidden="true"
                                            class="shrink-0 max-w-28 overflow-hidden whitespace-nowrap text-[11px] leading-none tabular-nums text-native-muted transition-[max-width,opacity] duration-150 group-hover/s:max-w-0 group-hover/s:opacity-0"
                                          >
                                        {timeLabel(session.time.updated ?? session.time.created)}
                                      </span>
                                      <div
                                        onClick={(e) => e.stopPropagation()}
                                        onPointerDown={(e) => e.stopPropagation()}
                                      >
                                        <DropdownMenu placement="bottom-end" gutter={4}>
                                          <DropdownMenu.Trigger
                                            as={IconButton}
                                            icon="dot-grid"
                                            variant="ghost"
                                            iconSize="small"
                                            class="shrink-0 size-6 rounded-md opacity-0 group-hover/s:opacity-100 transition-[width,opacity] duration-150 w-0 overflow-hidden group-hover/s:w-6"
                                          />
                                          <DropdownMenu.Portal>
                                            <DropdownMenu.Content style={{ "min-width": "104px" }}>
                                              <SessionActionMenuItems
                                                sessionID={session.id}
                                                getTitle={() => dw.session.get(session.id)?.title ?? ""}
                                                onRename={async (title) => {
                                                  await adapter.sessionUpdate({ sessionID: session.id, title })
                                                  dw.session.patch(session.id, { title })
                                                }}
                                                onDelete={() =>
                                                  adapter
                                                    .sessionDelete(session.id)
                                                    .then((x) => {
                                                      const ok = !!x.data
                                                      if (ok) dw.session.removeLocal(session.id)
                                                      return ok
                                                    })
                                                    .catch(() => false)
                                                }
                                              />
                                            </DropdownMenu.Content>
                                          </DropdownMenu.Portal>
                                        </DropdownMenu>
                                      </div>
                                    </div>
                                  )
                                }}
                              </For>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              }>
                <div class="px-3 py-2 text-12-regular text-text-weak">
                  {language.t("common.loading")}{language.t("common.loading.ellipsis")}
                </div>
              </Show>
            </Show>
            <Show when={active() === "files"}>
              <Show when={file.tree.isDisabled(props.directory)} fallback={
                <div class="p-2">
                  <FileTreeWithTabs path={props.directory} />
                </div>
              }>
                <div class="flex-1 flex flex-col items-center justify-center gap-3 text-text-weak py-8">
                  <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  <div class="text-14-medium">{language.t("file.tree.runtimeDisabled.title")}</div>
                  <div class="text-12-regular">{language.t("file.tree.runtimeDisabled.description")}</div>
                </div>
              </Show>
            </Show>
            <Show when={active() === "diffs"}>
              <Show when={!diff.state().disabled && diff.state().branch}>
                <div class="px-1.5 pt-0.5 pb-1 text-11-regular text-text-weak flex items-center gap-1.5">
                  <Icon name="branch" size="small" class="shrink-0" />
                  <span
                    class={`truncate ${
                      dw.data.vcs?.dirty === undefined
                        ? "text-text-weak"
                        : dw.data.vcs?.dirty
                        ? "text-git-dirty"
                        : "text-git-clean"
                    }`}
                  >
                    {diff.state().branch}
                    <Show when={(dw.data.vcs?.aheadCount ?? 0) > 0}>
                      {" "}↑{dw.data.vcs?.aheadCount}
                    </Show>
                    <Show when={(dw.data.vcs?.behindCount ?? 0) > 0}>
                      {" "}↓{dw.data.vcs?.behindCount}
                    </Show>
                  </span>
                  <Show when={dw.data.vcs?.lastCommitHash}>
                    <span class="ml-auto text-text-weak/60 shrink-0">{dw.data.vcs?.lastCommitHash}</span>
                  </Show>
                </div>
              </Show>
              <Show when={diff.state().disabled} fallback={
                <Show when={diff.state().stagedFiles.length > 0 || diff.state().unstagedFiles.length > 0 || diff.state().untrackedFiles.length > 0 || diff.state().loading} fallback={
                  <div class="px-3 py-2 text-12-regular text-text-weak">
                    {language.t("session.review.noChanges")}
                  </div>
                }>
                  <div class="px-0 py-0.5">
                  <Show when={diff.state().stagedFiles.length > 0}>
                    <div
                      class="px-1.5 pt-1.5 pb-0.5 flex items-center gap-1 text-[11px] font-[600] text-native-muted tracking-wide uppercase cursor-pointer hover:text-native-foreground transition-colors"
                      onClick={() => setDiffGroups((prev) => ({ ...prev, staged: !prev.staged }))}
                    >
                      <Icon name={diffGroups().staged ? "chevron-right" : "chevron-down"} size="small" class="shrink-0" />
                      {language.t("workspace.content.diff.staged")}
                      <span class="ml-auto text-11-regular tabular-nums">{diff.state().stagedFiles.length}</span>
                    </div>
                    <Show when={!diffGroups().staged}>
                      <For each={diff.state().stagedFiles}>
                        {(file) => (
                          <div class="flex items-center gap-1.5 h-6 px-1.5 text-12-regular hover:bg-native-hover rounded-md cursor-pointer transition-colors duration-150 group/diff"
                            onClick={() => {
                              tabStore.open({
                                kind: "diff",
                                key: `staged:${file.path}`,
                                title: getFilename(file.path),
                                icon: "file-tree",
                                meta: { path: file.path, status: file.status, staged: true },
                              })
                            }}
                          >
                            <span class="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] rounded-[3px]" style={{ ...statusBadgeStyle(file.status), color: "#ffffff", "font-weight": 700 }}>{statusLabel(file.status)}</span>
                            <span class="truncate flex-1 min-w-0" title={file.path}>{file.path}</span>
                            <Show when={file.additions > 0 || file.deletions > 0}>
                              <span class="shrink-0 text-11-regular tabular-nums flex items-center gap-0.5">
                                <Show when={file.additions > 0}>
                                  <span style={{ color: "hsl(160 84% 39%)" }}>+{file.additions}</span>
                                </Show>
                                <Show when={file.deletions > 0}>
                                  <span style={{ color: "hsl(0 84% 45%)" }}>-{file.deletions}</span>
                                </Show>
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                  <Show when={diff.state().unstagedFiles.length > 0}>
                    <div
                      class="px-1.5 pt-1.5 pb-0.5 flex items-center gap-1 text-[11px] font-[600] text-native-muted tracking-wide uppercase cursor-pointer hover:text-native-foreground transition-colors"
                      onClick={() => setDiffGroups((prev) => ({ ...prev, unstaged: !prev.unstaged }))}
                    >
                      <Icon name={diffGroups().unstaged ? "chevron-right" : "chevron-down"} size="small" class="shrink-0" />
                      {language.t("workspace.content.diff.unstaged")}
                      <span class="ml-auto text-11-regular tabular-nums">{diff.state().unstagedFiles.length}</span>
                    </div>
                    <Show when={!diffGroups().unstaged}>
                      <For each={diff.state().unstagedFiles}>
                        {(file) => (
                          <div class="flex items-center gap-1.5 h-6 px-1.5 text-12-regular hover:bg-native-hover rounded-md cursor-pointer transition-colors duration-150 group/diff"
                            onClick={() => {
                              tabStore.open({
                                kind: "diff",
                                key: `unstaged:${file.path}`,
                                title: getFilename(file.path),
                                icon: "file-tree",
                                meta: { path: file.path, status: file.status, staged: false },
                              })
                            }}
                          >
                            <span class="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] rounded-[3px]" style={{ ...statusBadgeStyle(file.status), color: "#ffffff", "font-weight": 700 }}>{statusLabel(file.status)}</span>
                            <span class="truncate flex-1 min-w-0" title={file.path}>{file.path}</span>
                            <Show when={file.additions > 0 || file.deletions > 0}>
                              <span class="shrink-0 text-11-regular tabular-nums flex items-center gap-0.5">
                                <Show when={file.additions > 0}>
                                  <span style={{ color: "hsl(160 84% 39%)" }}>+{file.additions}</span>
                                </Show>
                                <Show when={file.deletions > 0}>
                                  <span style={{ color: "hsl(0 84% 45%)" }}>-{file.deletions}</span>
                                </Show>
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                  <Show when={diff.state().untrackedFiles.length > 0}>
                    <div
                      class="px-1.5 pt-1.5 pb-0.5 flex items-center gap-1 text-[11px] font-[600] text-native-muted tracking-wide uppercase cursor-pointer hover:text-native-foreground transition-colors"
                      onClick={() => setDiffGroups((prev) => ({ ...prev, untracked: !prev.untracked }))}
                    >
                      <Icon name={diffGroups().untracked ? "chevron-right" : "chevron-down"} size="small" class="shrink-0" />
                      {language.t("workspace.content.diff.untracked")}
                      <span class="ml-auto text-11-regular tabular-nums">{diff.state().untrackedFiles.length}</span>
                    </div>
                    <Show when={!diffGroups().untracked}>
                      <For each={diff.state().untrackedFiles}>
                        {(file) => (
                          <div class="flex items-center gap-1.5 h-6 px-1.5 text-12-regular hover:bg-native-hover rounded-md cursor-pointer transition-colors duration-150 group/diff"
                            onClick={() => {
                              tabStore.open({
                                kind: "diff",
                                key: `untracked:${file.path}`,
                                title: getFilename(file.path),
                                icon: "file-tree",
                                meta: { path: file.path, status: file.status, staged: false },
                              })
                            }}
                          >
                            <span class="shrink-0 w-4 h-4 flex items-center justify-center text-[10px] rounded-[3px]" style={{ ...statusBadgeStyle(file.status), color: "#ffffff", "font-weight": 700 }}>{statusLabel(file.status)}</span>
                            <span class="truncate flex-1 min-w-0" title={file.path}>{file.path}</span>
                            <Show when={file.additions > 0 || file.deletions > 0}>
                              <span class="shrink-0 text-11-regular tabular-nums flex items-center gap-0.5">
                                <Show when={file.additions > 0}>
                                  <span style={{ color: "hsl(160 84% 39%)" }}>+{file.additions}</span>
                                </Show>
                                <Show when={file.deletions > 0}>
                                  <span style={{ color: "hsl(0 84% 45%)" }}>-{file.deletions}</span>
                                </Show>
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </div>
              </Show>
              }>
                <div class="flex-1 flex flex-col items-center justify-center gap-3 text-text-weak py-8">
                  <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  <div class="text-14-medium">{language.t("diff.list.runtimeDisabled.title")}</div>
                  <div class="text-12-regular">{language.t("diff.list.runtimeDisabled.description")}</div>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}


export function WorkspaceContentLayout(props: { workspaceId: string; directory: string }) {
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams<{ session?: string }>()
  const language = useLanguage()
  const tabStore = useContentTabs()
  const dl = useLayout()
  const ws = useDeviceWorkspace()
  const terminal = useDeviceTerminal()
  const active = createMemo(() => params.workspaceID === props.workspaceId)
  const [done, setDone] = createSignal<string | undefined>()
  const [autoExpandGroup, setAutoExpandGroup] = createSignal<{ group: string; nonce: number }>()

  const ready = createMemo(() => !!props.workspaceId && !!props.directory)
  const directory = createMemo(() => {
    if (!props.directory) return ""
    return workspaceKey(props.directory)
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest("input, textarea, select"))) return
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === "m") {
      e.preventDefault()
      e.stopPropagation()
      dl.fileTree.toggle()
    } else if (e.key === "n") {
      e.preventDefault()
      e.stopPropagation()
      newSessionCounter++
      tabStore.open({
        kind: "session",
        key: `new-${newSessionCounter}`,
        title: language.t("command.session.new"),
        icon: SESSION_TAB_ICON,
        meta: { sessionID: undefined },
      })
    } else if (e.key === "t") {
      e.preventDefault()
      e.stopPropagation()
      newTerminalCounter++
      const pendingKey = `pending-${newTerminalCounter}`
      tabStore.open({
        kind: "terminal",
        key: pendingKey,
        title: language.t("command.terminal.new"),
        icon: "terminal",
        meta: { sessionId: undefined },
      })
      terminal.new().then((sessionId) => {
        if (!sessionId) {
          return
        }
        tabStore.replace(tabStore.makeTabId("terminal", pendingKey), {
          kind: "terminal",
          key: sessionId,
          title: `Terminal`,
          icon: "terminal",
          meta: { sessionId },
        })
      })
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown, true)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown, true))
  })

  const syncUrlFromTab = (id: string | undefined) => {
    if (!id) {
      setSearchParams({ session: undefined }, { replace: true })
      return
    }
    const sid = activeSession(tabStore.tabs(), id)
    if (sid) {
      setSearchParams({ session: sid }, { replace: true })
      return
    }
    setSearchParams({ session: undefined }, { replace: true })
  }

  const restoreFromUrl = (sid: string, ws: ReturnType<typeof useDeviceWorkspace>) => {
    ws.session.clearUnread(sid)
    const existing = tabStore.tabs().find((t) => t.kind === "session" && t.meta?.sessionID === sid)
    if (existing) {
      tabStore.activate(existing.id)
      const session = ws.data.session.find((s) => s.id === sid)
      if (session) setAutoExpandGroup({ group: sessionGroup(session), nonce: Date.now() })
      return
    }
    const session = ws.data.session.find((s) => s.id === sid)
    tabStore.open({
      kind: "session",
      key: sid,
      title: session?.title || language.t("command.session.new"),
      icon: SESSION_TAB_ICON,
      meta: { sessionID: sid },
    })
    if (session) setAutoExpandGroup({ group: sessionGroup(session), nonce: Date.now() })
  }

  createEffect(() => {
    if (!active()) return
    const sid = searchParams.session
    if (!sid) {
      setDone(undefined)
      return
    }
    if (!shouldRestore(sid, done())) return
    if (ws.data.status === "loading") return
    restoreFromUrl(sid, ws)
    setDone(sid)
  })

  createEffect(() => {
    if (!active()) return
    if (shouldRestore(searchParams.session, done())) return
    syncUrlFromTab(tabStore.activeId())
  })

  createEffect(() => {
    const id = tabStore.activeId()
    if (!id) return
    const sid = activeSession(tabStore.tabs(), id)
    if (sid) {
      untrack(() => {
        ws.session.clearUnread(sid)
      })
    }
  })

  return (
    <Show
      when={ready() && directory()}
      fallback={<div class="size-full" />}
    >
      <div class="flex h-full w-full min-h-0 relative">
        <Show when={ws.restarting().active}>
          <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]">
            <div class="flex flex-col items-center gap-3 p-6 rounded-xl bg-surface-overlay shadow-xl">
              <svg class="size-6 text-text-warning animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="31.4 31.4" stroke-dashoffset="0" />
              </svg>
              <span class="text-14-medium text-text-default">{language.t("workspace.agent.restarting")}</span>
              <Show when={(ws.restarting() as any).message}>
                <span class="text-12-regular text-text-weak">{(ws.restarting() as any).message}</span>
              </Show>
            </div>
          </div>
        </Show>
        <div
          class="shrink-0 h-full overflow-hidden transition-[width] duration-200"
          style={{ width: dl.fileTree.opened() ? `${dl.fileTree.width()}px` : "0px" }}
        >
          <div class="h-full relative" style={{ width: `${dl.fileTree.width()}px` }}>
            <ContentSidebar directory={directory()!} autoExpandGroup={autoExpandGroup} />
            <ResizeHandle
              direction="horizontal"
              size={dl.fileTree.width()}
              min={160}
              max={500}
              collapseThreshold={100}
              onResize={dl.fileTree.resize}
              onCollapse={dl.fileTree.close}
            />
          </div>
        </div>

        <div class="flex-1 min-w-0 h-full flex flex-col">
          <Show when={ws.proxyError()}>
            {(code) => (
              <div class="shrink-0 h-8 flex items-center gap-2 px-3 border-b text-12-medium text-text-warning bg-surface-warning-weakest">
                <Icon name="warning" size="small" />
                <span>
                  <Switch>
                    <Match when={code() === "UPSTREAM_ERROR"}>{language.t("workspace.proxy.error.upstream")}</Match>
                    <Match when={code() === "FILTER_ERROR"}>{language.t("workspace.proxy.error.filter")}</Match>
                    <Match when={true}>{language.t("workspace.proxy.error.unknown", { code: code() })}</Match>
                  </Switch>
                </span>
              </div>
            )}
          </Show>
          <DeviceSessionStoreProvider>
            <PromptProvider>
              <SessionComposerRegistryProvider>
                <ContentTabPanel />
              </SessionComposerRegistryProvider>
            </PromptProvider>
          </DeviceSessionStoreProvider>
        </div>
      </div>
      <Toast.Region />
    </Show>
  )
}
