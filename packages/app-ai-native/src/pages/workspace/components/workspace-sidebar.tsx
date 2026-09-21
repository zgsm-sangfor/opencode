import { createSignal, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Device, DeviceStatus, Workspace, WorkspaceDirectory } from "../types"
import { DeviceItem } from "./device-item"
import { CreateWorkspaceDialogContent } from "./create-workspace-dialog"
import { useDeviceUpgrade } from "./use-device-upgrade"
import { useWorkspace } from "../context"
import { useWorkspaceNavigate } from "@/hooks/use-workspace-navigate"
import { useActiveWorkspace } from "../active-workspace"
import { useLanguage } from "@/context/language"
import { WorkspaceCard } from "./workspace-card"
import { Persist, persisted } from "@/utils/persist"

export function WorkspaceSidebar(props: { hide?: () => void } = {}) {
  const language = useLanguage()
  const t = language.t
  const dialog = useDialog()
  const hide = () => props.hide?.()
  const active = useActiveWorkspace()!
  const work = useWorkspace()
  const collapse = () => {
    if (props.hide) {
      props.hide()
      return
    }
    work.closeSidebar()
  }
  const {
    workspaces,
    devices,
    enabledWorkspaceIds,
    enableWorkspace,
    disableWorkspace,
    createWorkspace,
  } = work

  const params = useParams()
  const navigate = useNavigate()
  const { navigateToNewSession } = useWorkspaceNavigate()
  const [pinStore, setPinStore] = persisted(
    Persist.global("workspace.pins"),
    createStore<{ ids: string[] }>({ ids: [] }),
  )
  const pinSet = createMemo(() => new Set(pinStore.ids))
  const collator = createMemo(() => new Intl.Collator(language.locale(), { numeric: true, sensitivity: "base" }))
  const ordered = createMemo(() =>
    [...workspaces()].sort((a, b) => {
      const rank = (pinSet().has(b.id) ? 1 : 0) - (pinSet().has(a.id) ? 1 : 0)
      return rank || collator().compare(a.name, b.name)
    }),
  )
  const togglePin = (id: string) =>
    setPinStore("ids", (ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]))

  const isEnabled = (workspace: Workspace) => enabledWorkspaceIds().includes(workspace.id)

  const handleOpenWorkspace = (workspace: Workspace) => {
    if (!workspace.deviceUniqueId) return
    enableWorkspace(workspace.id)
    navigateToNewSession({ workspaceId: workspace.id })
    hide()
  }

  const handleCloseWorkspace = (workspace: Workspace) => {
    disableWorkspace(workspace.id)
    if (active.id === workspace.id) active.clear()
  }

  const runningIds = createMemo(() =>
    ordered()
      .filter((w) => isEnabled(w))
      .map((w) => w.id),
  )
  const idleIds = createMemo(() =>
    ordered()
      .filter((w) => !isEnabled(w))
      .map((w) => w.id),
  )

  const onlineDevices = createMemo(() => devices().filter((d) => d.status === "online"))

  const upgrade = useDeviceUpgrade({ devices, onUpgradeCompleted: work.refreshDevices })

  const hasUpgradableDevices = createMemo(() =>
    devices().some(
      (d) =>
        !!d.canUpdate &&
        d.status === "online" &&
        !upgrade.upgradeMap()[d.deviceId] &&
        !upgrade.isRecentlyUpgraded(d.deviceId),
    ),
  )

  const [createPopoverOpen, setCreatePopoverOpen] = createSignal(false)

  const handleCreateWorkspace = (device: Device) => {
    setCreatePopoverOpen(false)
    dialog.show(() => (
      <CreateWorkspaceDialogContent
        device={device}
        workspaceNames={workspaces().map((workspace) => workspace.name)}
        onCreate={async (directory: string, name: string) => {
          await createWorkspace(device.id, directory, name)
        }}
      />
    ))
  }

  const handleUpgrade = (device: Device) => {
    setCreatePopoverOpen(false)
    upgrade.upgradeDevice(device)
  }

  const handleManageDevices = () => {
    setCreatePopoverOpen(false)
    hide()
    navigate("/console/devices")
  }

  const [deviceRefreshing, setDeviceRefreshing] = createSignal(false)
  let lastDeviceRefreshTs = 0
  const handleDeviceRefresh = () => {
    if (deviceRefreshing()) return
    const now = Date.now()
    if (now - lastDeviceRefreshTs < 1000) return
    lastDeviceRefreshTs = now
    setDeviceRefreshing(true)
    const minSpin = new Promise((r) => setTimeout(r, 600))
    Promise.all([work.refreshDevices(), minSpin]).finally(() => setDeviceRefreshing(false))
  }

  return (
    <aside class="flex h-full w-full flex-col bg-[linear-gradient(180deg,color-mix(in_oklab,var(--native-panel)_88%,var(--native-bg-subtle)),var(--native-panel))] text-sidebar-foreground">
      <div class="flex h-[41px] shrink-0 items-center gap-2 px-3">
        <span class="min-w-0 flex-1 font-[var(--native-font-display)] text-[1rem] font-semibold tracking-[-0.035em] text-sidebar-foreground">{t("workspace.page.title")}</span>
        <Show when={params.workspaceID}>
          <Tooltip value={t("workspace.sidebar.collapse")} placement="bottom">
            <IconButton
              icon="chevron-left"
              variant="ghost"
              iconSize="small"
              onClick={collapse}
              aria-label={t("workspace.sidebar.collapse")}
            />
          </Tooltip>
        </Show>
      </div>

      <div class="shrink-0 px-3 py-2.5">
        <Popover
          open={createPopoverOpen()}
          onOpenChange={setCreatePopoverOpen}
        >
          <div class="relative">
            <PopoverTrigger
              as={Button}
              variant="ghost"
              icon="plus-small"
              class="w-full h-8 shrink-0 justify-center gap-1.5 rounded-[var(--native-radius-sm)] border border-transparent cursor-pointer bg-[color:color-mix(in_oklab,var(--native-primary)_72%,var(--native-panel))] text-[var(--native-primary-foreground)] text-sm font-medium transition-colors duration-200 hover:bg-[var(--native-primary)] [&_[data-slot=icon-svg]]:text-[var(--native-primary-foreground)]"
              aria-label={t("workspace.device.createWorkspace")}
            >
              {t("workspace.device.createWorkspace")}
            </PopoverTrigger>
            <Show when={hasUpgradableDevices()}>
              <span class="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-[#ff9800] ring-[1.5px] ring-[var(--native-panel)]" />
            </Show>
          </div>
          <PopoverContent class="w-80 rounded-[var(--native-radius-md)] border border-sidebar-border bg-sidebar p-1.5 shadow-[var(--native-shadow-md)]">
            <div class="flex items-center gap-1 px-2 py-1.5">
              <span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70">{t("workspace.createFromDevice")}</span>
              <div class="ml-auto flex items-center gap-0.5">
                <Tooltip value={t("workspace.device.manage")} placement="bottom">
                  <button
                    type="button"
                    class="flex size-6 items-center justify-center rounded-[var(--native-radius-sm)] text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors cursor-pointer focus:outline-none"
                    onClick={handleManageDevices}
                    aria-label={t("workspace.device.manage")}
                  >
                    <Icon name="configuration" size="small" />
                  </button>
                </Tooltip>
                <Tooltip value={t("workspace.device.refresh")} placement="bottom">
                  <button
                    type="button"
                    class="flex size-6 items-center justify-center rounded-[var(--native-radius-sm)] text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors cursor-pointer focus:outline-none"
                    classList={{ "pointer-events-none": deviceRefreshing() }}
                    onClick={handleDeviceRefresh}
                    aria-label={t("workspace.device.refresh")}
                  >
                    <Icon name="arrows-rotate" size="small" classList={{ "animate-spin": deviceRefreshing() }} />
                  </button>
                </Tooltip>
              </div>
            </div>
            <Show
              when={onlineDevices().length > 0}
              fallback={
                <div class="flex flex-col items-center gap-1 px-2 py-6 text-center">
                  <Icon name="server" class="size-6 text-sidebar-foreground/30" />
                  <span class="text-xs text-sidebar-foreground/50">{t("workspace.createFromDevice.empty")}</span>
                </div>
              }
            >
              <ul class="space-y-0.5">
                <For each={onlineDevices()}>
                  {(device) => {
                    const state = () => upgrade.upgradeMap()[device.deviceId]
                    const hasUpgrade = () =>
                      !!device.canUpdate &&
                      device.status === "online" &&
                      !state() &&
                      !upgrade.isRecentlyUpgraded(device.deviceId)
                    return (
                      <DeviceItem
                        device={device}
                        upgradeState={state()}
                        hasUpgrade={hasUpgrade()}
                        onCreate={handleCreateWorkspace}
                        onUpgrade={handleUpgrade}
                      />
                    )
                  }}
                </For>
              </ul>
            </Show>
          </PopoverContent>
        </Popover>
      </div>

      <div class="thin-scrollbar min-h-0 flex-1 overflow-y-auto py-1 pr-1">
        <Show when={runningIds().length > 0 || idleIds().length > 0}>
          <div class="mb-3 px-2">
            <div class="mb-1 flex items-center gap-1.5 px-2.5 py-1.5">
              <span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70">{t("workspace.running")}</span>
              <span class="ml-auto rounded-[var(--native-radius-full)] bg-[color:color-mix(in_oklab,var(--native-primary)_8%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--native-primary)]">{runningIds().length}</span>
              <Show when={runningIds().length > 0}>
                <Tooltip value={t("workspace.closeAllRunning")} placement="bottom">
                  <IconButton
                    icon="close"
                    variant="ghost"
                    iconSize="small"
                    class="size-7 rounded-lg cursor-pointer text-sidebar-foreground/70 hover:text-sidebar-foreground"
                    onClick={() => {
                      const ids = runningIds()
                      for (const id of ids) {
                        disableWorkspace(id)
                      }
                      if (active.id && ids.includes(active.id)) active.clear()
                      navigate("/workspace")
                    }}
                    aria-label={t("workspace.closeAllRunning")}
                  />
                </Tooltip>
              </Show>
            </div>
            <Show
              when={runningIds().length > 0}
              fallback={
                <div class="flex flex-col items-center justify-center rounded-[var(--native-radius-md)] border border-[color:color-mix(in_oklab,var(--native-border)_24%,transparent)] bg-[color:color-mix(in_oklab,var(--native-surface)_60%,var(--native-panel))] px-3 py-4 text-center">
                  <span class="text-[11px] font-medium text-sidebar-foreground/55">{t("workspace.running.empty")}</span>
                  <span class="mt-1 flex items-center gap-1 text-[11px] leading-[1.5] text-sidebar-foreground/40">
                    <Icon name="arrow-up" class="size-3 rotate-180" />
                    {t("workspace.running.emptyHint")}
                  </span>
                </div>
              }
            >
              <div class="flex flex-col gap-1">
                <For each={runningIds()}>
                  {(id) => (
                    <WorkspaceCard
                      id={id}
                      isRunning={true}
                      pinned={pinSet().has(id)}
                      onTogglePin={() => togglePin(id)}
                      onOpen={handleOpenWorkspace}
                      onClose={handleCloseWorkspace}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <div class="px-2">
          <div class="mb-1 flex items-center gap-1.5 px-2.5 py-1.5">
            <span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/70">{t("workspace.idle")}</span>
            <span class="ml-auto rounded-[var(--native-radius-full)] bg-[color:color-mix(in_oklab,var(--native-panel)_82%,var(--native-bg-subtle))] px-2 py-0.5 text-[11px] font-medium text-sidebar-foreground/55">{idleIds().length}</span>
          </div>
          <div class="flex flex-col gap-1.5">
            <For each={idleIds()}>
              {(id) => (
                <WorkspaceCard
                  id={id}
                  isRunning={false}
                  pinned={pinSet().has(id)}
                  onTogglePin={() => togglePin(id)}
                  onOpen={handleOpenWorkspace}
                  onClose={handleCloseWorkspace}
                />
              )}
            </For>
            <Show when={workspaces().length === 0}>
              <div class="flex flex-col items-center justify-center rounded-[var(--native-radius-lg)] border border-[color:color-mix(in_oklab,var(--native-border)_24%,transparent)] bg-[color:color-mix(in_oklab,var(--native-surface)_72%,var(--native-panel))] py-8 text-sidebar-foreground/50">
                <Icon name="folder" class="mb-2 size-8 opacity-30" />
                <span class="text-xs font-medium text-sidebar-foreground/65">{t("workspace.empty")}</span>
                <span class="mt-1 flex items-center gap-1 text-[11px] leading-[1.5] text-sidebar-foreground/40">
                  <Icon name="arrow-up" class="size-3" />
                  {t("workspace.emptyHint")}
                </span>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </aside>
  )
}
