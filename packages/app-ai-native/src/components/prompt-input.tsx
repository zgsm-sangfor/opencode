import { useFilteredList } from "@opencode-ai/ui/hooks"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { useWorkspaceVisible } from "@/pages/workspace/components/layout"
import { WorkspaceContext } from "@/pages/workspace/context"
import {
  createEffect,
  on,
  Component,
  Show,
  onCleanup,
  onMount,
  Switch,
  Match,
  createMemo,
  createSignal,
  useContext,
} from "solid-js"
import { createStore } from "solid-js/store"
import { createFocusSignal } from "@solid-primitives/active-element"
import { useDeviceLocal } from "@/context/device-local"
import { useDeviceWorkspace } from "@/context/device-workspace"
import { useFile } from "@/context/file"
import { useDeviceClient } from "@/context/device-client"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
  WorkspacePart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useDeviceSDK } from "@/context/device-sdk"

import { Button } from "@opencode-ai/ui/button"
import { DockShellForm, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { Switch as UiSwitch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { DialogSelectModelUnpaid } from "@/components/dialog-select-model-unpaid"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { useLanguage } from "@/context/language"
import { useContentTabs } from "@/context/content-tabs"
import { useSlashActions } from "@/pages/session/slash-actions"
import { usePlatform } from "@/context/platform"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments, ACCEPTED_FILE_TYPES } from "./prompt-input/attachments"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { StatusDisplay } from "@/pages/session/composer/session-status-display"
import { ImagePreview } from "@opencode-ai/ui/image-preview"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  onSubmit?: () => void
  hideAttachButton?: boolean
  busySince?: number
  queued?: string[]
  onQueueChange?: (items: string[]) => void
  // Optional hidden instruction seeded into the first message of a new session.
  hiddenSeed?: () => string | undefined
}

const TIPS = [
  "prompt.tip.1",
  "prompt.tip.2",
  "prompt.tip.3",
  "prompt.tip.4",
  "prompt.tip.5",
  "prompt.tip.6",
  "prompt.tip.7",
  "prompt.tip.8",
  "prompt.tip.9",
  "prompt.tip.10",
  "prompt.tip.11",
  "prompt.tip.12",
  "prompt.tip.13",
] as const

const NON_EMPTY_TEXT = /[^\s\u200B]/

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useDeviceSDK()
  const local = useDeviceLocal()
  const files = useFile()
  const device = useDeviceClient()
  const workspace = useDeviceWorkspace()
  const prompt = usePrompt()
  const layout = useLayout()
  const command = useCommand()
  const dialog = useDialog()
  const providers = useProviders()
  const language = useLanguage()
  const platform = usePlatform()
  const slashActions = useSlashActions()
  const tabStore = useContentTabs()
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement
  let atPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 44

  const sid = createMemo(() => local.activeSessionID())

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = () => {
    requestAnimationFrame(scrollCursorIntoView)
  }

  const sessionKey = createMemo(() => sid() ?? "")
  const tabs = createMemo(() => layout.tabs(sessionKey))
  const view = createMemo(() => layout.view(sessionKey))

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = tabs().active()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => {
    const id = sid()
    if (!id) return undefined
    return workspace.session.get(id) ?? { id }
  })
  const status = createMemo(
    () =>
      workspace.data.sessionStatus[sid() ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => status()?.type !== "idle")
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
    workspaceFileSearch: { id: string; name: string; directory: string } | null
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * TIPS.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
    workspaceFileSearch: null,
  })

  const q = (): string[] => props.queued ?? []
  const setQ = (items: string[]) => props.onQueueChange?.(items)

  const visible = useWorkspaceVisible()
  const buttonsSpring = useSpring(
    () => (store.mode === "normal" ? 1 : 0),
    { visualDuration: 0.2, bounce: 0 },
    () => !visible(),
  )

  const contextItems = createMemo(() => prompt.context.items())

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )

  const tip = createMemo(() => language.t(TIPS[store.placeholder]))

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: 0,
      tip: tip(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const isFocused = createFocusSignal(() => editorRef)
  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => {
    setStore("popover", null)
    setStore("workspaceFileSearch", null)
  }

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "t" && e.key !== "T") return
    const target = e.target as HTMLElement
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return
    if (!editorRef || editorRef.offsetParent === null) return
    e.preventDefault()
    focusEditorEnd()
  }
  document.addEventListener("keydown", handleGlobalKeyDown)
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown))

  createEffect(() => {
    if (prompt.dirty()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % TIPS.length)
    }, 10000)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const agentList = createMemo(() =>
    (workspace.data.agent ?? [])
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.name })),
  )
  const agentNames = createMemo(() => local.agent.list().map((agent) => agent.name))

  const workspaceCtx = useContext(WorkspaceContext)
  const workspaceList = createMemo(() => {
    if (!workspaceCtx) return []
    const all = workspaceCtx.workspaces()
    const current = all.find((w) => w.id === workspaceCtx.selectedWorkspaceId())
    if (!current?.deviceId) return []
    return all
      .filter((w) => w.deviceId === current.deviceId)
      .map((w): AtOption => {
        const dir = w.directories?.find((d) => d.isDefault) || w.directories?.[0]
        return { type: "workspace", id: w.id, name: w.name, directory: dir?.path ?? "", display: w.name }
      })
  })

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else if (option.type === "workspace") {
      addPart({
        type: "workspace",
        workspaceId: option.id,
        workspaceName: option.name,
        directory: option.directory,
        content: "@" + option.name,
        start: 0,
        end: 0,
      })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    if (x.type === "agent") return `agent:${x.name}`
    if (x.type === "workspace") return `workspace:${x.id}`
    return `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const workspaces = workspaceList()
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...workspaces, ...agents, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...workspaces, ...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "workspace") return "workspace"
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "workspace") return 0
        if (category === "agent") return 1
        if (category === "recent") return 2
        return 3
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
    maxItems: 10,
  })

  let wsSearchTimer: ReturnType<typeof setTimeout> | undefined
  const searchWorkspaceFiles = (query: string, directory: string) => {
    const normalized = query.replace(/\\/g, "/")
    const scoped = device.createClient({ directory, throwOnError: true })
    return new Promise<string[]>((resolve) => {
      if (wsSearchTimer) clearTimeout(wsSearchTimer)
      const delay = query.trim() ? 300 : 0
      wsSearchTimer = setTimeout(() => {
        wsSearchTimer = undefined
        scoped.runtime.findFiles(normalized, "true").then(
          (x) => {
            resolve((x as string[] | undefined) ?? [])
          },
          () => resolve([]),
        )
      }, delay)
    })
  }

  const trimAfterAt = () => {
    const cursor = getCursorPosition(editorRef)
    const raw = prompt
      .current()
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
    const match = raw.substring(0, cursor).match(/@(\S*)$/)
    if (!match || match.index == null) {
      setEditorText("@")
      prompt.set([{ type: "text", content: "@", start: 0, end: 1 }], 1)
      return
    }
    const range = document.createRange()
    setRangeEdge(editorRef, range, "start", match.index + 1)
    setRangeEdge(editorRef, range, "end", cursor)
    range.deleteContents()
    const updated = parseFromDOM()
    prompt.set(updated, match.index + 1)
  }

  const enterWorkspaceFileSearch = (ws: { id: string; name: string; directory: string }) => {
    setStore("workspaceFileSearch", ws)
    trimAfterAt()
    wsFileRefetch()
    focusEditorEnd()
  }

  const exitWorkspaceFileSearch = () => {
    setStore("workspaceFileSearch", null)
    trimAfterAt()
    atOnInput("")
    focusEditorEnd()
  }

  const handleWsFileSelect = (option: AtOption | undefined) => {
    if (!option || option.type !== "file") return
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const {
    flat: wsFileFlat,
    active: wsFileActive,
    setActive: wsFileSetActiveActive,
    onInput: wsFileOnInput,
    onKeyDown: wsFileOnKeyDown,
    refetch: wsFileRefetch,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const ws = store.workspaceFileSearch
      if (!ws) return []
      const paths = await searchWorkspaceFiles(query, ws.directory)
      return paths.map((path) => ({ type: "file" as const, path, display: path }))
    },
    key: atKey,
    filterKeys: ["display"],
    noInitialSelection: true,
    onSelect: handleWsFileSelect,
    maxItems: 10,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin: SlashCommand[] = [
      {
        id: "cmd.compact",
        trigger: "compact",
        title: language.t("command.session.compact"),
        description: language.t("command.session.compact.description"),
        type: "custom" as const,
        autoSubmit: true,
      },
      {
        id: "cmd.new",
        trigger: "new",
        title: language.t("command.session.new"),
        description: language.t("command.session.new.description"),
        type: "builtin" as const,
        scope: "action",
        onAction: () => {
          const id = tabStore.activeId()
          if (id) tabStore.replaceWithNewSession(id, language.t("command.session.new"))
        },
      },
      {
        id: "cmd.clear",
        trigger: "clear",
        title: language.t("command.session.clear"),
        description: language.t("command.session.clear.description"),
        type: "builtin" as const,
        scope: "action",
        onAction: () => {
          const id = tabStore.activeId()
          if (id) tabStore.replaceWithNewSession(id, language.t("command.session.new"))
        },
      },
      {
        id: "cmd.models",
        trigger: "models",
        title: language.t("command.model.choose"),
        description: language.t("command.model.choose.description"),
        type: "builtin" as const,
        scope: "action",
      },
      {
        id: "cmd.agents",
        trigger: "agents",
        title: language.t("command.agent.cycle"),
        description: language.t("command.agent.cycle.description"),
        type: "builtin" as const,
        scope: "action",
      },
      // {
      //   id: "cmd.hub",
      //   trigger: "hub",
      //   title: language.t("command.favorites.title"),
      //   description: language.t("command.favorites.description"),
      //   type: "builtin" as const,
      //   scope: "action",
      // },
    ]

    const frontendOnly = new Set(
      builtin.filter((c) => c.scope === "action").map((c) => c.trigger),
    )

    const backend = (workspace.data.command ?? [])
      .filter((cmd) => cmd.scope !== "tui-only")
      .filter((cmd) => !frontendOnly.has(cmd.name))
      .map((cmd) => ({
        id: `cmd.${cmd.name}`,
        trigger: cmd.name === "favorites" ? "hub" : cmd.name,
        title: cmd.title || cmd.name,
        description: cmd.name === "favorites" ? language.t("command.favorites.description") : cmd.description,
        keybind: cmd.keybind,
        scope: cmd.scope,
        type: cmd.scope === "prompt" || !cmd.scope ? ("custom" as const) : ("builtin" as const),
        source: cmd.source as SlashCommand["source"],
      }))

    return [...backend, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()

    if (cmd.onAction) {
      clearEditor()
      prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
      cmd.onAction()
      return
    }

    if (cmd.scope === "prompt" || !cmd.scope || cmd.autoSubmit) {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      if (cmd.autoSubmit) {
        handleSubmit(new Event("submit"))
      } else {
        focusEditorEnd()
      }
      return
    }

    clearEditor()
    prompt.set([{ type: "text", content: "", start: 0, end: 0 }], 0)
    slashActions.execute(cmd.trigger)
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart | WorkspacePart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    if (part.type === "workspace") {
      pill.setAttribute("data-workspace-id", part.workspaceId)
      pill.setAttribute("data-workspace-name", part.workspaceName)
      pill.setAttribute("data-directory", part.directory)
    }
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      if (el.dataset.type === "workspace") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent" || part.type === "workspace") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
    editorRef.normalize()
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  createEffect(() => {
    const activeKey = store.workspaceFileSearch ? wsFileActive() : atActive()
    if (!activeKey || !atPopoverRef) return

    requestAnimationFrame(() => {
      const element = atPopoverRef.querySelector(`[data-at-key="${activeKey}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })

  const selectPopoverActive = () => {
    if (store.popover === "at") {
      if (store.workspaceFileSearch) {
        const items = wsFileFlat()
        if (items.length === 0) return
        const active = wsFileActive()
        const item = items.find((entry) => atKey(entry) === active) ?? items[0]
        handleWsFileSelect(item)
        return
      }
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  createEffect(
    on(
      () => prompt.current(),
      (currentParts) => {
        const inputParts = currentParts.filter((part) => part.type !== "image")

        if (composing()) {
          if (mirror.input) mirror.input = false
          return
        }

        if (mirror.input) {
          mirror.input = false
          if (isNormalizedEditor()) return

          renderEditorWithCursor(inputParts)
          return
        }

        const domParts = parseFromDOM()
        if (isNormalizedEditor() && isPromptEqual(inputParts, domParts)) return

        renderEditorWithCursor(inputParts)
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushWorkspace = (ws: HTMLElement) => {
      const content = ws.textContent ?? ""
      parts.push({
        type: "workspace",
        workspaceId: ws.dataset.workspaceId!,
        workspaceName: ws.dataset.workspaceName!,
        directory: ws.dataset.directory!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.dataset.type === "workspace") {
        flushText()
        pushWorkspace(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        if (store.workspaceFileSearch) {
          wsFileOnInput(atMatch[1])
          setStore("popover", "at")
        } else {
          atOnInput(atMatch[1])
          setStore("popover", "at")
        }
      } else if (slashMatch) {
        void workspace.command.load()
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent" || part.type === "workspace") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt, [])
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: [],
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addImageAttachment, removeImageAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isFocused,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })

  const variants = createMemo(() => ["default", ...local.model.variant.list()])
  const accepting = createMemo(() => workspace.autoAccept.enabled())

  const { abort, handleSubmit } = createPromptSubmit({
    info,
    imageAttachments,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    onSubmit: props.onSubmit,
    hiddenSeed: props.hiddenSeed,
    onCommand: (name) => {
      const cmd = slashCommands().find((c) => c.trigger === name && c.onAction)
      if (!cmd) return false
      prompt.reset()
      setStore("mode", "normal")
      setStore("popover", null)
      cmd.onAction!()
      return true
    },
  })

  // Wrap submit to queue messages when session is busy
  const handleSubmitOrQueue = (e: Event) => {
    if (working()) {
      const text = prompt.current().map((p) => ("content" in p ? p.content : "")).join("")
      const images = imageAttachments()
      if (text.trim() || images.length > 0) {
        setQ([...q(), text])
        prompt.reset()
        clearEditor()
      } else {
        abort()
      }
      e.preventDefault()
      return
    }
    handleSubmit(e)
  }

  // Auto-flush queue when session transitions from busy -> idle
  createEffect(
    on(
      () => status().type,
      (curr, prev) => {
        if (curr === "idle" && (prev === "busy" || prev === "retry" || prev === "compacting")) {
          const msgs = q()
          if (msgs.length > 0) {
            setQ([])
            setTimeout(() => {
              const text = msgs.join("\n\n")
              setEditorText(text)
              prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
              handleSubmit(new Event("submit"))
            }, 0)
          }
        }
      },
    ),
  )

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      editorRef.blur()
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "ArrowLeft" && store.workspaceFileSearch) {
        exitWorkspaceFileSearch()
        event.preventDefault()
        return
      }
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          if (store.workspaceFileSearch) {
            wsFileOnKeyDown(event)
          } else {
            atOnKeyDown(event)
          }
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
      if (store.popover === "at" && !store.workspaceFileSearch && event.key === "ArrowRight") {
        const active = atActive()
        const items = atFlat()
        const item = items.find((entry) => atKey(entry) === active)
        if (item?.type === "workspace" && item.id !== workspaceCtx?.selectedWorkspaceId()) {
          enterWorkspaceFileSearch({ id: item.id, name: item.name, directory: item.directory })
          event.preventDefault()
          return
        }
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      handleSubmitOrQueue(event)
    }
  }

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-0">
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        setAtPopoverRef={(el) => (atPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        workspaceFileSearch={store.workspaceFileSearch}
        wsFileFlat={wsFileFlat()}
        wsFileActive={wsFileActive() ?? undefined}
        setWsFileActive={wsFileSetActiveActive}
        onWsFileSelect={handleWsFileSelect}
        currentWorkspaceId={workspaceCtx?.selectedWorkspaceId() ?? ""}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <DockShellForm
        onSubmit={handleSubmitOrQueue}
        classList={{
          "group/prompt-input": true,
          "focus-within:shadow-xs-border": true,
          "border-icon-info-active border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={contextItems()}
          remove={(item) => {
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
        />
        <PromptImageAttachments
          attachments={imageAttachments()}
          onOpen={(attachment) =>
            dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
          }
          onRemove={removeImageAttachment}
          removeLabel={language.t("prompt.attachment.remove")}
          uploadingLabel={language.t("prompt.attachment.uploading")}
          errorLabel={language.t("prompt.attachment.uploadError")}
          unsupportedLabel={language.t("prompt.attachment.requiresUpgrade")}
        />
        <div
          class="relative"
          onMouseDown={(e) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            if (
              target.closest(
                '[data-action="prompt-attach"], [data-action="prompt-submit"], [data-action="prompt-permissions"]',
              )
            ) {
              return
            }
            editorRef?.focus()
          }}
        >
          <div class="relative max-h-[240px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
            <div
              data-component="prompt-input"
              ref={(el) => {
                editorRef = el
                props.ref?.(el)
              }}
              role="textbox"
              aria-multiline="true"
              aria-label={placeholder()}
              contenteditable="true"
              autocapitalize="off"
              // autocorrect="off" 会在 contenteditable div 上破坏中文 IME 输入(第一下无回显),
              // 这是一个非标准属性,浏览器对其处理方式会干扰 IME context 的稳定性
              spellcheck={false}
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              classList={{
                "select-text": true,
                "w-full pl-3 pr-2 pt-2 pb-11 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
                "[&_[data-type=file]]:text-syntax-property": true,
                "[&_[data-type=agent]]:text-syntax-type": true,
                "[&_[data-type=workspace]]:text-icon-warning-active": true,
                "font-mono!": store.mode === "shell",
              }}
            />
            <Show when={!prompt.dirty()}>
              <div
                class="absolute top-0 inset-x-0 pl-3 pr-2 pt-2 pb-11 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
                classList={{ "font-mono!": store.mode === "shell" }}
              >
                {placeholder()}
              </div>
            </Show>
          </div>

          <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES.join(",")}
              class="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0]
                if (file) addImageAttachment(file)
                e.currentTarget.value = ""
              }}
            />

            <div
              aria-hidden={store.mode !== "normal"}
              class="flex items-center gap-1"
              style={{
                "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
              }}
            >
              <Show when={!props.hideAttachButton}>
                <TooltipKeybind
                  placement="top"
                  title={language.t("prompt.action.attachFile")}
                  keybind={command.keybind("file.attach")}
                >
                  <Button
                    data-action="prompt-attach"
                    type="button"
                    variant="ghost"
                    class="size-8 p-0"
                    style={{
                      opacity: buttonsSpring(),
                      transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                      filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                    }}
                    onClick={pick}
                    disabled={store.mode !== "normal"}
                    tabIndex={store.mode === "normal" ? undefined : -1}
                    aria-label={language.t("prompt.action.attachFile")}
                  >
                    <Icon name="plus" class="size-4.5" />
                  </Button>
                </TooltipKeybind>
              </Show>

              <Tooltip
                placement="top"
                inactive={!prompt.dirty() && !working()}
                value={
                  <Switch>
                    <Match when={working()}>
                      <div class="flex items-center gap-2">
                        <span>{language.t("prompt.action.stop")}</span>
                        <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
                      </div>
                    </Match>
                    <Match when={true}>
                      <div class="flex items-center gap-2">
                        <span>{language.t("prompt.action.send")}</span>
                        <Icon name="enter" size="small" class="text-icon-base" />
                      </div>
                    </Match>
                  </Switch>
                }
              >
                <IconButton
                  data-action="prompt-submit"
                  type="submit"
                  disabled={store.mode !== "normal" || (!prompt.dirty() && !working())}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  icon={working() ? "stop" : "arrow-up"}
                  variant="primary"
                  class="size-8"
                  style={{
                    opacity: buttonsSpring(),
                    transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                    filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                  }}
                  aria-label={working() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                />
              </Tooltip>
            </div>
          </div>
        </div>
      </DockShellForm>
      <Show when={store.mode === "normal" || store.mode === "shell"}>
        <DockTray attach="top">
          <div class="px-1.75 py-2 flex items-center gap-2 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
              <div
                class="h-7 flex items-center gap-1.5 max-w-[160px] min-w-0 absolute inset-y-0 left-0"
                style={{
                  padding: "0 4px 0 8px",
                  opacity: 1 - buttonsSpring(),
                  transform: `scale(${0.95 + (1 - buttonsSpring()) * 0.05})`,
                  filter: `blur(${buttonsSpring() * 2}px)`,
                  "pointer-events": buttonsSpring() < 0.5 ? "auto" : "none",
                }}
              >
                <span class="truncate text-13-medium text-text-strong">{language.t("prompt.mode.shell")}</span>
                <div class="size-4 shrink-0" />
              </div>
              <div class="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
                <TooltipKeybind
                  placement="top"
                  gutter={4}
                  title={language.t("command.agent.cycle")}
                  keybind={command.keybind("agent.cycle")}
                >
                  <Select
                    size="normal"
                    options={agentNames()}
                    current={local.agent.current()?.name ?? ""}
                    onSelect={local.agent.set}
                    class="capitalize max-w-24 sm:max-w-32 min-w-0 shrink"
                    valueClass="truncate text-13-regular"
                    triggerStyle={{
                      height: "28px",
                      opacity: buttonsSpring(),
                      transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                      filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                      "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                    }}
                    variant="ghost"
                  />
                </TooltipKeybind>
                <Show
                  when={providers.paid().length > 0}
                  fallback={
                    <TooltipKeybind
                      placement="top"
                      gutter={4}
                      title={language.t("command.model.choose")}
                      keybind={command.keybind("model.choose")}
                    >
                      <Button
                        as="div"
                        variant="ghost"
                        size="normal"
                        class="min-w-0 max-w-[120px] sm:max-w-none shrink text-13-regular group"
                        style={{
                          height: "28px",
                          opacity: buttonsSpring(),
                          transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                          filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                          "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                        }}
                        onClick={() => dialog.show(() => <DialogSelectModelUnpaid />)}
                      >
                        <Show when={local.model.current()?.provider?.id}>
                          <ProviderIcon
                            id={local.model.current()!.provider.id}
                            class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                            style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                          />
                        </Show>
                        <span class="truncate">
                          {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                        </span>
                        <Icon name="chevron-down" size="small" class="shrink-0" />
                      </Button>
                    </TooltipKeybind>
                  }
                >
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    title={language.t("command.model.choose")}
                    keybind={command.keybind("model.choose")}
                  >
                    <ModelSelectorPopover
                      triggerAs={Button}
                      triggerProps={{
                        variant: "ghost",
                        size: "normal",
                        style: {
                          height: "28px",
                          opacity: buttonsSpring(),
                          transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                          filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                          "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                        },
                        class: "min-w-0 max-w-[120px] sm:max-w-none shrink text-13-regular group",
                      }}
                    >
                      <Show when={local.model.current()?.provider?.id}>
                        <ProviderIcon
                          id={local.model.current()!.provider.id}
                          class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                          style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                        />
                      </Show>
                      <span class="truncate">
                        {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                      </span>
                      <Icon name="chevron-down" size="small" class="shrink-0" />
                    </ModelSelectorPopover>
                  </TooltipKeybind>
                </Show>
                <Show when={variants().length > 1}>
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    title={language.t("command.model.variant.cycle")}
                    keybind={command.keybind("model.variant.cycle")}
                  >
                    <Select
                      size="normal"
                      options={variants()}
                      current={local.model.variant.current() ?? "default"}
                      label={(x) => (x === "default" ? language.t("common.default") : x)}
                      onSelect={(x) => local.model.variant.set(x === "default" ? undefined : x)}
                      class="capitalize max-w-30 sm:max-w-none min-w-0 shrink"
                      valueClass="truncate text-13-regular"
                      triggerProps={{ "data-action": "model-variant-cycle" }}
                      triggerStyle={{
                        height: "28px",
                        opacity: buttonsSpring(),
                        transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                        filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                        "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                      }}
                      variant="ghost"
                    />
                  </TooltipKeybind>
                </Show>
                <Show when={store.mode === "normal"}>
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    title={language.t(
                      accepting() ? "command.permissions.autoaccept.disable" : "command.permissions.autoaccept.enable",
                    )}
                    keybind={command.keybind("permissions.autoaccept")}
                  >
                    {/* Full label (wider screens) */}
                    <label
                      class="hidden sm:flex items-center gap-1.5 shrink-0 cursor-pointer select-none h-7"
                      style={{
                        opacity: buttonsSpring(),
                        transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                        filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                        "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        class="size-3.5 accent-[var(--native-primary)] cursor-pointer"
                        checked={accepting()}
                        onChange={() => workspace.autoAccept.toggle()}
                      />
                      <span class="text-12-regular text-text-weak truncate">
                        {language.t("command.permissions.autoaccept.enable")}
                      </span>
                    </label>
                    {/* Icon + switch (smaller screens) */}
                    <div
                      class="sm:hidden flex items-center gap-1 shrink-0"
                      style={{
                        opacity: buttonsSpring(),
                        transform: `scale(${0.95 + buttonsSpring() * 0.05})`,
                        filter: `blur(${(1 - buttonsSpring()) * 2}px)`,
                        "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
                      }}
                    >
                      <Icon
                        name={accepting() ? "shield" : "shield-2"}
                        size="small"
                        classList={{ "text-icon-success-base": accepting() }}
                      />
                      <UiSwitch
                        checked={accepting()}
                        onChange={(checked) => {
                          if (checked) workspace.autoAccept.enable()
                          else workspace.autoAccept.disable()
                        }}
                        data-variant="quiet"
                        hideLabel
                      >
                        {language.t("command.permissions.autoaccept.enable")}
                      </UiSwitch>
                    </div>
                  </TooltipKeybind>
                </Show>
              </div>
            </div>
            <div class="shrink-0">
              <RadioGroup
                options={["shell", "normal"] as const}
                current={store.mode}
                value={(mode) => mode}
                label={(mode) => (
                  <TooltipKeybind
                    placement="top"
                    gutter={4}
                    openDelay={2000}
                    title={language.t(mode === "shell" ? "prompt.mode.shell" : "prompt.mode.normal")}
                    keybind={command.keybind(mode === "shell" ? "prompt.mode.shell" : "prompt.mode.normal")}
                    class="size-full flex items-center justify-center"
                  >
                    <Icon
                      name={mode === "shell" ? "console" : "prompt"}
                      class="size-[18px]"
                      classList={{
                        "text-icon-strong-base": store.mode === mode,
                        "text-icon-weak": store.mode !== mode,
                      }}
                    />
                  </TooltipKeybind>
                )}
                onSelect={(mode) => mode && setMode(mode)}
                fill
                pad="none"
                class="w-[68px]"
              />
            </div>
          </div>
        </DockTray>
      </Show>
    </div>
  )
}
