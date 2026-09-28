import { For, createEffect, createMemo, on, onCleanup, Show, Index, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { TimelineMessage } from "@opencode-ai/ui/timeline-message"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AssistantMessage, Message as MessageType, Part, TextPart } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { getFilename } from "@opencode-ai/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useSessionChat } from "@/context/session-chat"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { DialogDeleteSession } from "@/pages/workspace/components/session-dialogs"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

export function MessageTimeline(props: {
  mobileChanges: boolean
  mobileFallback: JSX.Element
  scroll: { overflow: boolean; bottom: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  isDesktop: boolean
  onScrollSpyScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void | Promise<void>
  renderedMessages: MessageType[]
  anchor: (id: string) => string
  onRegisterMessage: (el: HTMLDivElement, id: string) => void
  onUnregisterMessage: (id: string) => void
  hideHeader?: boolean
}) {
  let touchGesture: number | undefined

  const params = useParams()
  const navigate = useNavigate()
  const chat = useSessionChat()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()

  const rendered = createMemo(() => props.renderedMessages)

  let scrollEl: HTMLDivElement | undefined
  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scrollEl = el
    props.setScrollRef(el)
  }
  const handleLoadEarlier = () => {
    const scroller = scrollEl
    if (!scroller) {
      const result = props.onLoadEarlier()
      if (result instanceof Promise) void result.catch(() => undefined)
      return
    }
    const prevTop = scroller.scrollTop
    const prevHeight = scroller.scrollHeight
    const restore = () =>
      requestAnimationFrame(() => {
        const delta = scroller.scrollHeight - prevHeight
        if (delta > 0) scroller.scrollTop = prevTop + delta
      })
    const result = props.onLoadEarlier()
    if (result instanceof Promise) {
      void result.then(restore).catch(() => undefined)
      return
    }
    restore()
  }

  const sid = createMemo(() => chat.activeSessionID())
  const sessionKey = createMemo(() => {
    const id = sid()
    return `${id ?? ""}`
  })
  const sessionID = sid
  const sessionMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return emptyMessages
    return chat.messages(id)
  })
  const pending = createMemo(() =>
    sessionMessages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    ),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return chat.sessionStatus(id)
  })
  const activeMessageID = createMemo(() => {
    const parentID = pending()?.parentID
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message: any) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus()
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return chat.getSession(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const parentID = createMemo(() => info()?.parentID)
  const showHeader = createMemo(() => !props.hideHeader && !!(titleValue() || parentID()))
  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    saving: false,
  })
  let titleRef: HTMLInputElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  createEffect(
    on(
      sessionKey,
      () => setTitle({ draft: "", editing: false, saving: false }),
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID()) return
    setTitle({ editing: true, draft: titleValue() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (title.saving) return
    setTitle({ editing: false, saving: false })
  }

  const saveTitleEditor = async () => {
    const id = sessionID()
    if (!id) return
    if (title.saving) return

    const next = title.draft.trim()
    if (!next || next === (titleValue() ?? "")) {
      setTitle({ editing: false, saving: false })
      return
    }

    setTitle("saving", true)
    await chat
      .renameSession(id, next)
      .then(() => {
        setTitle({ editing: false, saving: false })
      })
      .catch((err) => {
        setTitle("saving", false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string) => {
    if (sid() !== sessionID) return
    if (parentID) {
      navigate(`/workspace/${params.workspaceID}/${parentID}`)
      return
    }

    navigate(`/workspace/${params.workspaceID}`)
  }

  const handleSessionDeleted = (sessionID: string) => {
    const session = chat.getSession(sessionID)
    navigateAfterSessionRemoval(sessionID, session?.parentID)
  }

  const handleSessionDeleteFailed = (err: unknown) => {
    showToast({
      title: language.t("session.delete.failed.title"),
      description: errorMessage(err),
    })
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    const back = chat.navigateBack?.()
    if (back) { back(); return }
    navigate(`/workspace/${params.workspaceID}/${id}`)
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-6 z-[60] pointer-events-none transition-[opacity,transform] duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100":
              props.scroll.overflow && !props.scroll.bottom,
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || props.scroll.bottom,
          }}
        >
          <button
            class="pointer-events-auto size-8 flex items-center justify-center rounded-full bg-background-base border shadow-sm text-text-base hover:bg-background-stronger transition-colors"
            onClick={props.onResumeScroll}
          >
            <Icon name="arrow-down-to-line" />
          </button>
        </div>
        <ScrollView
          viewportRef={setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onAutoScrollHandleScroll()
            props.onMarkScrollGesture(e.currentTarget)
            if (props.isDesktop) props.onScrollSpyScroll()
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": showHeader() ? "40px" : "0px",
            "--sticky-accordion-top": showHeader() ? "48px" : "0px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <Show when={showHeader()}>
              <div
                data-session-title
                classList={{
                  "sticky top-0 z-30 bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]": true,
                  "w-full": true,
                  "pb-4": true,
                  "pl-2 pr-3 md:pl-4 md:pr-3": true,
                  "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                }}
              >
                <div class="h-12 w-full flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
                    <Show when={parentID()}>
                      <IconButton
                        tabIndex={-1}
                        icon="arrow-left"
                        variant="ghost"
                        onClick={navigateParent}
                        aria-label={language.t("common.goBack")}
                      />
                    </Show>
                    <Show when={titleValue() || title.editing}>
                      <Show
                        when={title.editing}
                        fallback={
                          <h1 class="text-14-medium text-text-strong truncate grow-1 min-w-0 pl-2 cursor-default">
                            {titleValue()}
                          </h1>
                        }
                      >
                        <InlineInput
                          ref={(el) => {
                            titleRef = el
                          }}
                          value={title.draft}
                          disabled={title.saving}
                          class="text-14-medium text-text-strong grow-1 min-w-0 pl-2 rounded-[6px]"
                          style={{ "--inline-input-shadow": "var(--shadow-xs-border-select)" }}
                          onInput={(event) => setTitle("draft", event.currentTarget.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation()
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void saveTitleEditor()
                              return
                            }
                            if (event.key === "Escape") {
                              event.preventDefault()
                              closeTitleEditor()
                            }
                          }}
                          onBlur={closeTitleEditor}
                        />
                      </Show>
                    </Show>
                  </div>
                  <Show when={sessionID()} keyed>
                    {(id) => (
                      <DropdownMenu
                        gutter={4}
                        placement="bottom-end"
                      >
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          variant="ghost"
                          class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                          aria-label={language.t("common.moreOptions")}
                        />
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content style={{ "min-width": "104px" }}>
                            <DropdownMenu.Item onSelect={openTitleEditor}>
                              <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator />
                            <DropdownMenu.Item
                              onSelect={() => dialog.show(() => (
                                <DialogDeleteSession
                                  name={chat.getSession(id)?.title ?? language.t("command.session.new")}
                                  onConfirm={() => chat.deleteSession(id)}
                                  onDeleted={() => handleSessionDeleted(id)}
                                  onDeleteFailed={handleSessionDeleteFailed}
                                />
                              ))}
                            >
                              <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    )}
                  </Show>
                </div>
              </div>
            </Show>

            <div
              role="log"
              class="flex flex-col gap-2 items-start justify-start pt-4 pb-16 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-12-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={handleLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(message) => {
                  const messageID = message.id
                  const active = createMemo(() => {
                    const activeID = activeMessageID()
                    if (!activeID) return false
                    if (message.role === "user") return messageID === activeID
                    if (message.role === "assistant") {
                      const parentID = (message as { parentID?: string }).parentID
                      return !!parentID && parentID === activeID
                    }
                    return false
                  })
                  const comments = createMemo(() => messageComments(chat.messageParts(messageID)), [], {
                    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
                  })
                  const commentCount = createMemo(() => comments().length)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      ref={(el) => {
                        props.onRegisterMessage(el, messageID)
                        onCleanup(() => props.onUnregisterMessage(messageID))
                      }}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-200 2xl:max-w-[1000px]": props.centered,
                      }}
                    >
                      <Show when={commentCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                                      <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                                        <FileIcon
                                          node={{ path: comment().path, type: "file" }}
                                          class="size-3.5 shrink-0"
                                        />
                                        <span class="truncate">{getFilename(comment().path)}</span>
                                        <Show when={comment().selection}>
                                          {(selection) => (
                                            <span class="shrink-0 text-text-weak">
                                              {selection().startLine === selection().endLine
                                                ? `:${selection().startLine}`
                                                : `:${selection().startLine}-${selection().endLine}`}
                                            </span>
                                          )}
                                        </Show>
                                      </div>
                                      <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                                        {comment().comment}
                                      </div>
                                    </div>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <TimelineMessage
                        sessionID={sessionID() ?? ""}
                        message={message}
                        active={active()}
                        status={sessionStatus()}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        classes={{
                          root: "min-w-0 w-full relative",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
