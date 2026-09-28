import { Component, createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { getDirectory, getFilename } from "@opencode-ai/util/path"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }
  | { type: "workspace"; id: string; name: string; directory: string; display: string }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
  scope?: string
  autoSubmit?: boolean
  onAction?: () => void
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  setAtPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  workspaceFileSearch: { id: string; name: string; directory: string } | null
  wsFileFlat: AtOption[]
  wsFileActive?: string
  setWsFileActive: (id: string) => void
  onWsFileSelect: (item: AtOption) => void
  currentWorkspaceId: string
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  loading: boolean
  t: (key: string) => string
}

function FileItem(props: { item: AtOption; atKey: string; isActive: boolean; onActive: () => void; onSelect: () => void; "data-at-key"?: string }) {
  const path = () => (props.item as { type: "file"; path: string }).path
  const isDirectory = () => path().endsWith("/")
  const directory = () => (isDirectory() ? path() : getDirectory(path()))
  const filename = () => (isDirectory() ? "" : getFilename(path()))

  return (
    <button
      data-at-key={props["data-at-key"]}
      class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
      classList={{ "bg-surface-raised-base-hover": props.isActive }}
      onClick={() => props.onSelect()}
      onMouseEnter={() => props.onActive()}
    >
      <FileIcon node={{ path: path(), type: "file" }} class="shrink-0 size-4" />
      <div class="flex items-center text-14-regular min-w-0">
        <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory()}</span>
        <Show when={!isDirectory()}>
          <span class="text-text-strong whitespace-nowrap">{filename()}</span>
        </Show>
      </div>
    </button>
  )
}

function LoadingOverlay(props: { show: boolean; label: string }) {
  const [mount, setMount] = createSignal(false)
  const [visible, setVisible] = createSignal(false)
  let frame: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer) clearTimeout(timer)
    if (props.show) {
      setMount(true)
      frame = requestAnimationFrame(() => {
        frame = undefined
        setVisible(true)
      })
      return
    }
    setVisible(false)
    timer = setTimeout(() => setMount(false), 150)
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    if (timer) clearTimeout(timer)
  })

  return (
    <Show when={mount()}>
      <div
        aria-busy="true"
        aria-label={props.label}
        class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[12px]
               bg-surface-raised-stronger-non-alpha/60 backdrop-blur-[1px]
               transition-opacity duration-150 ease-out motion-reduce:transition-none"
        classList={{ "opacity-0": !visible(), "opacity-100": visible() }}
      >
        <Spinner class="size-4 text-text-weak" />
      </div>
    </Show>
  )
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left"
        onMouseDown={(e) => e.preventDefault()}
      >
        <div class="relative overflow-hidden rounded-[12px] bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]">
          <div
            ref={(el) => {
              if (props.popover === "slash") props.setSlashPopoverRef(el)
              if (props.popover === "at") props.setAtPopoverRef(el)
            }}
            class="max-h-80 min-h-10 overflow-auto no-scrollbar flex flex-col p-2"
          >
            <Switch>
              <Match when={props.popover === "at" && props.workspaceFileSearch}>
                <div class="flex items-center justify-between gap-x-2 px-1 pb-1 mb-1 border-b border-[var(--native-border)]">
                  <div class="flex items-center gap-x-2 min-w-0">
                    <Icon name="folder" size="small" class="text-icon-warning-active shrink-0" />
                    <span class="text-13-medium text-text-strong whitespace-nowrap truncate">{props.workspaceFileSearch!.name}</span>
                  </div>
                  <span class="text-11-regular text-text-subtle shrink-0">{props.t("prompt.popover.workspace.exit")}</span>
                </div>
                <Show
                  when={props.wsFileFlat.length > 0}
                  fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.workspaceFile.empty")}</div>}
                >
                  <For each={props.wsFileFlat}>
                    {(item) => {
                      const key = props.atKey(item)
                      return (
                        <FileItem
                          data-at-key={key}
                          item={item}
                          atKey={key}
                          isActive={props.wsFileActive === key}
                          onActive={() => props.setWsFileActive(key)}
                          onSelect={() => props.onWsFileSelect(item)}
                        />
                      )
                    }}
                  </For>
                </Show>
              </Match>
              <Match when={props.popover === "at"}>
                <Show
                  when={props.atFlat.length > 0}
                  fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
                >
                  <For each={props.atFlat}>
                    {(item) => {
                      const key = props.atKey(item)

                      if (item.type === "agent") {
                        return (
                          <button
                            data-at-key={key}
                            class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                            classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                            onClick={() => props.onAtSelect(item)}
                            onMouseEnter={() => props.setAtActive(key)}
                          >
                            <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                            <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                          </button>
                        )
                      }

                      if (item.type === "workspace") {
                        const isCurrent = item.id === props.currentWorkspaceId
                        const isActive = () => props.atActive === key && !isCurrent
                        return (
                          <button
                            data-at-key={key}
                            class="w-full flex items-center justify-between gap-x-2 rounded-md px-2 py-0.5"
                            classList={{ "bg-surface-raised-base-hover": props.atActive === key }}
                            onClick={() => props.onAtSelect(item)}
                            onMouseEnter={() => props.setAtActive(key)}
                          >
                            <div class="flex items-center gap-x-2 min-w-0">
                              <Icon name="folder" size="small" class="text-icon-warning-active shrink-0" />
                              <span class="text-14-regular text-text-strong whitespace-nowrap truncate">{item.name}</span>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0">
                              <Show when={isActive()}>
                                <span class="text-11-regular text-text-subtle">{props.t("prompt.popover.workspace.enter")}</span>
                              </Show>
                              <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">workspace</span>
                            </div>
                          </button>
                        )
                      }

                      return (
                        <FileItem
                          data-at-key={key}
                          item={item}
                          atKey={key}
                          isActive={props.atActive === key}
                          onActive={() => props.setAtActive(key)}
                          onSelect={() => props.onAtSelect(item)}
                        />
                      )
                    }}
                  </For>
                </Show>
              </Match>
              <Match when={props.popover === "slash"}>
                <Show
                  when={props.slashFlat.length > 0}
                  fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
                >
                  <For each={props.slashFlat}>
                    {(cmd) => (
                      <button
                        data-slash-id={cmd.id}
                        classList={{
                          "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                          "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                        }}
                        onClick={() => props.onSlashSelect(cmd)}
                        onMouseEnter={() => props.setSlashActive(cmd.id)}
                      >
                        <div class="flex items-center gap-2 min-w-0">
                          <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                          <Show when={cmd.description}>
                            <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                          </Show>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                           <Show when={cmd.type === "builtin"}>
                             <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">Builtin</span>
                           </Show>
                           <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                            <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                              {cmd.source === "skill"
                                ? props.t("prompt.slash.badge.skill")
                                : cmd.source === "mcp"
                                  ? props.t("prompt.slash.badge.mcp")
                                  : props.t("prompt.slash.badge.custom")}
                            </span>
                          </Show>
                          <Show when={props.commandKeybind(cmd.id)}>
                            <span class="text-12-regular text-text-subtle">{props.commandKeybind(cmd.id)}</span>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </Match>
            </Switch>
          </div>
          <LoadingOverlay show={props.loading} label={props.t("common.loading")} />
        </div>
      </div>
    </Show>
  )
}
