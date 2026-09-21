import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useLanguage } from "@/context/language"
import { useDeviceWorkspace } from "@/context/device-workspace"
import { useContentTabs } from "@/context/content-tabs"
import { useSessionChat } from "@/context/session-chat"
import { sessionTreeIDs } from "@/pages/session/composer/session-request-tree"
import { SessionActionMenuItems } from "./session-action-menu"
import { HoverScrollText } from "./hover-scroll-text"
import type { Session } from "@opencode-ai/sdk/v2/client"

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

export function sessionGroup(session: { time?: { updated?: number; created?: number } }) {
  const now = Date.now()
  const startOfDay = new Date(now).setHours(0, 0, 0, 0)
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
  const t = session.time?.updated ?? session.time?.created ?? 0
  return t >= startOfDay ? "today" : t >= sevenDaysAgo ? "thisWeek" : "older"
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

export function SessionListPanel() {
  const language = useLanguage()
  const dw = useDeviceWorkspace()
  const tabStore = useContentTabs()
  const chat = useSessionChat()
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
    const ids = tabStore
      .tabs()
      .filter((tab) => tab.kind === "session" && tab.meta?.sessionID && !live.has(tab.meta.sessionID) && !tabStore.isPendingSession(tab.meta.sessionID))
      .map((tab) => tab.id)
    if (ids.length === 0) return
    ids.forEach(tabStore.close)
  })

  return (
    <div class="flex flex-col h-full">
      <div class="flex-1 min-h-0 overflow-y-auto">
        <Show
          when={dw.data.status === "loading"}
          fallback={
            <Show
              when={sessionGroups().length > 0}
              fallback={
                <div class="px-3 py-2 text-12-regular text-text-weak">
                  {language.t("workspace.emptySessions")}
                </div>
              }
            >
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
                                          getTitle={() => chat.getSession(session.id)?.title ?? ""}
                                          onRename={(title) => chat.renameSession(session.id, title)}
                                          onDelete={() => chat.deleteSession(session.id)}
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
          }
        >
          <div class="px-3 py-2 text-12-regular text-text-weak">
            {language.t("common.loading")}{language.t("common.loading.ellipsis")}
          </div>
        </Show>
      </div>
    </div>
  )
}
