import { createMemo, createSignal, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import type { DeviceStatus, Workspace, WorkspaceDirectory } from "../types"
import { useWorkspace } from "../context"
import { useLanguage } from "@/context/language"
import { useWorkspaceSummary } from "@/context/workspace-summary-store"

export function getPrimaryDirectory(workspace: Workspace): WorkspaceDirectory | undefined {
  if (!workspace.directories || workspace.directories.length === 0) return undefined
  return workspace.directories.find((d) => d.isDefault) || workspace.directories[0]
}

export function getDeviceStatusDot(status: DeviceStatus | undefined, t: (key: string) => string) {
  switch (status) {
    case "online":
      return { online: true, offline: false, text: t("workspace.device.online") }
    case "offline":
      return { online: false, offline: true, text: t("workspace.device.offline") }
    default:
      return { online: false, offline: false, text: t("workspace.device.unbound") }
  }
}

export interface WorkspaceCardProps {
  id: string
  isRunning: boolean
  pinned?: boolean
  onTogglePin?: () => void
  onOpen: (workspace: Workspace) => void
  onClose: (workspace: Workspace) => void
}

export function WorkspaceCard(props: WorkspaceCardProps) {
  const language = useLanguage()
  const t = language.t
  const work = useWorkspace()
  const params = useParams()

  const workspace = createMemo(() => work.workspaces().find((w) => w.id === props.id))
  const primaryDir = createMemo(() => {
    const ws = workspace()
    return ws ? getPrimaryDirectory(ws) : undefined
  })
  const dot = createMemo(() => getDeviceStatusDot(workspace()?.deviceStatus, t))
  const device = createMemo(() => {
    const ws = workspace()
    if (!ws?.deviceId) return undefined
    return work.devices().find((d) => d.id === ws.deviceId)
  })
  const summary = useWorkspaceSummary(props.id)
  const [renaming, setRenaming] = createSignal(false)
  const [renameValue, setRenameValue] = createSignal("")
  const isActive = createMemo(() => params.workspaceID === props.id)
  const useDetailed = createMemo(() => props.isRunning)

  const startRename = () => {
    setRenameValue(workspace()?.name ?? "")
    setRenaming(true)
  }

  let committing = false
  const commitRename = async () => {
    if (committing) return
    committing = true
    setRenaming(false)
    const val = renameValue().trim()
    if (val && val !== workspace()?.name) {
      await work.renameWorkspace(props.id, val).catch(() => null)
    }
    committing = false
  }

  const handleRenameKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") commitRename()
    if (e.key === "Escape") {
      committing = true
      setRenaming(false)
      committing = false
    }
  }

  const renameInput = () => (
    <input
      class="flex-1 min-w-0 rounded-[var(--native-radius-sm)] bg-[color:color-mix(in_oklab,var(--native-panel)_80%,var(--native-bg-subtle))] px-2 py-1 text-sm font-medium text-sidebar-foreground shadow-[var(--native-shadow-sm)] focus:outline-none focus:ring-1 focus:ring-sidebar-ring"
      value={renameValue()}
      placeholder={t("workspace.rename.placeholder")}
      onInput={(e: Event) => setRenameValue((e.target as HTMLInputElement).value)}
      onBlur={commitRename}
      onKeyDown={handleRenameKey}
      ref={(el) => setTimeout(() => el?.focus(), 0)}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    />
  )

  const detail = () => {
    const parts = [device()?.displayName, primaryDir()?.path].filter(Boolean)
    if (workspace()?.isDefault) parts.push(t("common.default"))
    return parts.join(" · ") || t("workspace.device.unbound")
  }

  const menu = () => (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={IconButton}
        icon="dot-grid"
        variant="ghost"
        class="size-7 rounded-lg cursor-pointer text-sidebar-foreground/70 hover:text-sidebar-foreground"
        aria-label={t("workspace.more")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-36 bg-sidebar shadow-md">
          <Show when={props.onTogglePin}>
            <DropdownMenu.Item class="hover:bg-sidebar-accent" onSelect={() => props.onTogglePin?.()}>
              <Icon
                name="pin"
                size="small"
                class="size-4"
                classList={{ "text-[var(--native-primary)]": props.pinned, "text-sidebar-foreground/70": !props.pinned }}
              />
              <DropdownMenu.ItemLabel>{props.pinned ? t("workspace.unpin") : t("workspace.pin")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <Show when={props.isRunning}>
            <DropdownMenu.Item class="hover:bg-sidebar-accent" onSelect={() => props.onClose(workspace()!)}>
              <Icon name="stop" size="small" class="size-4 text-sidebar-foreground/70" />
              <DropdownMenu.ItemLabel>{t("workspace.close")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <Show when={!props.isRunning && !dot().offline}>
            <DropdownMenu.Item class="hover:bg-sidebar-accent" onSelect={() => props.onOpen(workspace()!)}>
              <Icon name="enter" size="small" class="size-4 text-sidebar-foreground/70" />
              <DropdownMenu.ItemLabel>{t("workspace.run")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
          <DropdownMenu.Item class="hover:bg-sidebar-accent" onSelect={startRename}>
            <Icon name="edit" size="small" class="size-4 text-sidebar-foreground/70" />
            <DropdownMenu.ItemLabel>{t("workspace.rename")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <Show when={!props.isRunning}>
            <DropdownMenu.Separator class="bg-sidebar-border" />
            <DropdownMenu.Item class="hover:bg-sidebar-accent" onSelect={() => work.deleteWorkspace(props.id)}>
              <Icon name="trash" size="small" class="size-4 text-destructive" />
              <DropdownMenu.ItemLabel>{t("workspace.delete")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )

  return (
    <Show when={workspace()}>
      {(ws) => (
        <Show
          when={useDetailed()}
          fallback={
            <div
              class="group/workspace flex items-center rounded-md transition-all duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              classList={{
                "bg-[color:color-mix(in_oklab,var(--native-primary)_8%,var(--native-panel))] shadow-[var(--native-shadow-sm)]": isActive(),
              }}
            >
              <Tooltip
                placement="bottom-end"
                value={detail()}
                class="flex-1 min-w-0"
                contentStyle={{
                  background: "hsl(var(--sidebar-accent))",
                  color: "hsl(var(--sidebar-accent-foreground))",
                  "box-shadow": "var(--shadow-xs)",
                }}
              >
                <button
                  class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  classList={{
                    "text-sidebar-foreground/75 cursor-pointer": !dot().offline,
                    "text-sidebar-foreground/40 cursor-not-allowed": dot().offline,
                  }}
                  onClick={() => {
                    if (!dot().offline) props.onOpen(ws())
                  }}
                >
                  <div
                    classList={{
                      "size-2 rounded-full shrink-0": true,
                      "bg-icon-success-base": dot().online,
                      "bg-icon-critical-base": dot().offline,
                      "bg-sidebar-border": !dot().online && !dot().offline,
                    }}
                  />
                  <Show when={props.pinned}>
                    <span class="flex size-4 shrink-0 items-center justify-center text-[var(--native-primary)]" title={t("workspace.pinned")}>
                      <Icon name="pin" size="small" class="size-3.5" />
                    </span>
                  </Show>
                  <Show
                    when={renaming()}
                    fallback={
                      <span
                        class="text-sm truncate flex-1"
                        onDblClick={(e: MouseEvent) => {
                          e.stopPropagation()
                          startRename()
                        }}
                      >
                        {workspace()?.name}
                      </span>
                    }
                  >
                    {renameInput()}
                  </Show>
                </button>
              </Tooltip>
              <div class="ml-auto flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity duration-150 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100">
                {menu()}
              </div>
            </div>
          }
        >
          <div
            class="group/workspace relative flex rounded-md transition-all duration-150 text-sidebar-foreground shadow-[var(--native-shadow-sm)]"
            classList={{
              "bg-[color:color-mix(in_oklab,var(--native-primary)_8%,var(--native-panel))]": isActive(),
              "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground": !isActive(),
            }}
          >
            <button
              class="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-2 pr-9 text-left text-sm transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              onClick={() => {
                if (!dot().offline) props.onOpen(ws())
              }}
            >
              <div class="flex items-center gap-2">
                <div
                  classList={{
                    "size-2 rounded-full shrink-0": true,
                    "bg-icon-success-base": dot().online,
                    "bg-icon-critical-base": dot().offline,
                    "bg-sidebar-border": !dot().online && !dot().offline,
                  }}
                />
                <Show when={props.pinned}>
                  <span class="flex size-4 shrink-0 items-center justify-center text-[var(--native-primary)]" title={t("workspace.pinned")}>
                    <Icon name="pin" size="small" class="size-3.5" />
                  </span>
                </Show>
                <Show
                  when={renaming()}
                  fallback={
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                      <Show when={summary()?.hasPendingInteraction}>
                        <div class="shrink-0 flex items-center justify-center w-4 h-4 animate-bell" style={{ "transform-origin": "top center" }}>
                          <Icon name="bell" size="small" style={{ color: "#ffa000" }} />
                        </div>
                      </Show>
                      <Show when={!summary()?.hasPendingInteraction && summary()?.hasActiveSession}>
                        <div class="shrink-0 flex items-center justify-center w-4 h-4">
                          <div class="size-3 rounded-full border border-[var(--native-primary)] border-t-transparent animate-spin" />
                        </div>
                      </Show>
                      <Show when={summary()?.hasUnreadSession}>
                        <span class="shrink-0 w-2 h-2 rounded-full bg-[var(--native-primary)]" />
                      </Show>
                      <span
                        class="text-sm font-medium truncate"
                        onDblClick={(e: MouseEvent) => {
                          e.stopPropagation()
                          startRename()
                        }}
                      >
                        {workspace()?.name}
                      </span>
                    </div>
                  }
                >
                  {renameInput()}
                </Show>
              </div>
              <Show when={!renaming()}>
                <div class="flex items-center gap-2">
                  <span class="shrink-0 w-2 flex items-center justify-center text-sidebar-foreground/40">
                    <Icon name="branch" size="small" class="size-3" />
                  </span>
                  <Show
                    when={summary()?.branch}
                    fallback={
                      <span class="text-sm truncate text-sidebar-foreground/40">
                        {t("workspace.sidebar.notGitRepo")}
                      </span>
                    }
                  >
                    <div class="flex items-center gap-1.5 min-w-0">
                      <Show when={summary()?.dirty === undefined || summary()?.dirty === true || (summary()?.aheadCount ?? 0) > 0 || (summary()?.behindCount ?? 0) > 0}>
                        <span class="flex items-center gap-1 shrink-0">
                          <Show when={summary()?.dirty === undefined || summary()?.dirty === true}>
                            <Show when={(summary()?.aheadCount ?? 0) === 0 && (summary()?.behindCount ?? 0) === 0}>
                              <span
                                class={`size-2 rounded-full ${
                                  summary()?.dirty === undefined
                                    ? "bg-sidebar-foreground/30"
                                    : "bg-git-dirty"
                                }`}
                                title={summary()?.dirty ? "Dirty" : ""}
                              />
                            </Show>
                          </Show>
                          <Show when={(summary()?.aheadCount ?? 0) > 0 || (summary()?.behindCount ?? 0) > 0}>
                            <span
                              class="rounded-full text-[10px] font-medium tabular-nums"
                              style={
                                summary()?.dirty === undefined
                                  ? { "background-color": "color-mix(in oklab, var(--sidebar-foreground) 15%, transparent)", color: "var(--sidebar-foreground)", padding: "2px 6px", "line-height": "1" }
                                  : summary()?.dirty
                                  ? { "background-color": "var(--git-dirty-soft)", color: "var(--git-dirty)", padding: "2px 6px", "line-height": "1" }
                                  : { "background-color": "var(--git-clean-soft)", color: "var(--git-clean)", padding: "2px 6px", "line-height": "1" }
                              }
                              title={summary()?.dirty === undefined ? "" : summary()?.dirty ? "Dirty" : "Clean"}
                            >
                              <Show when={(summary()?.aheadCount ?? 0) > 0}>
                                ↑{summary()?.aheadCount}
                              </Show>
                              <Show when={(summary()?.behindCount ?? 0) > 0}>
                                ↓{summary()?.behindCount}
                              </Show>
                            </span>
                          </Show>
                        </span>
                      </Show>
                      <span class="text-sm truncate text-sidebar-foreground/40">
                        {summary()?.branch}
                      </span>
                    </div>
                  </Show>
                </div>
                <div class="flex items-center gap-2" title={device()?.displayName || ""}>
                  <span class="shrink-0 w-2 flex items-center justify-center text-sidebar-foreground/40">
                    <Icon name="folder" size="small" class="size-3" />
                  </span>
                  <span class="text-sm truncate text-sidebar-foreground/40">
                    {primaryDir()?.path || ""}
                  </span>
                </div>
              </Show>
            </button>
            <div class="absolute right-1 top-1.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/workspace:opacity-100 group-focus-within/workspace:opacity-100">
              {menu()}
            </div>
          </div>
        </Show>
      )}
    </Show>
  )
}
