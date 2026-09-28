import { createContext, useContext, type ParentProps } from "solid-js"
import type {
  Message,
  Part,
  Session,
  SessionStatus,
  Todo,
  Command,
  Agent,
  VcsInfo,
  PermissionRequest,
  QuestionRequest,
  Path,
} from "@opencode-ai/sdk/v2/client"
import type { ProviderCapabilitiesResponse } from "./global-sync/types"

export type ModelKey = { providerID: string; modelID: string }

export type ModelInfo = {
  id: string
  name: string
  provider: { id: string; name: string }
  latest?: boolean
} & Record<string, unknown>

export type AgentInfo = {
  name: string
  mode?: string
  hidden?: boolean
  model?: ModelKey
  variant?: string
}

export interface SessionChatBackend {
  directory: () => string
  workspaceId: () => string | undefined
  workspaceStatus: () => string

  sessions: () => Session[]
  sessionTotal: () => number
  sessionStatus: (id: string) => SessionStatus

  agents: () => Agent[]
  commands: () => Command[]
  providerCaps: () => ProviderCapabilitiesResponse
  permissions: () => Record<string, PermissionRequest[]>
  questions: () => Record<string, QuestionRequest[]>
  vcs: () => VcsInfo | undefined
  vcsLoad: () => Promise<void>

  agentAvailable: () => boolean

  messages: (id: string) => Message[]
  parts: () => Record<string, Part[]>
  messageParts: (messageId: string) => Part[]
  partProgress: () => Record<string, string[]>
  todos: (id: string) => Todo[]

  loadMessages: (id: string) => Promise<void>
  loadTodo: (id: string) => Promise<void>
  historyLoading: (id: string) => boolean
  clearUnread: (id: string) => void

  getSession: (id: string) => Session | undefined
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<boolean>

  permissionRespond: (id: string, decision: "once" | "always" | "reject") => Promise<void>
  removePermission: (sessionId: string, permId: string) => void
  removeQuestion: (sessionId: string, requestId: string) => void

  autoAccept: {
    enabled: () => boolean
    enable: () => void
  }

  agent: {
    current: () => AgentInfo | undefined
    set: (name: string | undefined) => void
  }
  model: {
    current: () => ModelInfo | undefined
    set: (key: ModelKey | undefined) => void
    ready: () => boolean
  }

  activeSessionID: () => string | undefined
  setActiveSession: (id: string | undefined) => void
  setOnSessionCreated: (fn: ((input: { sessionID: string; title?: string }) => void) | undefined) => void
  navigateBack: () => (() => void) | undefined
  setNavigateBack: (fn: (() => void) | undefined) => void

  findSessionName: (id: string) => string
}

const SessionChatContext = createContext<SessionChatBackend>()

export function useSessionChat() {
  const ctx = useContext(SessionChatContext)
  if (!ctx) throw new Error("useSessionChat must be used within a SessionChatProvider")
  return ctx
}

export function SessionChatProvider(props: ParentProps<{ value: SessionChatBackend }>) {
  return (
    <SessionChatContext.Provider value={props.value}>
      {props.children}
    </SessionChatContext.Provider>
  )
}

export { SessionChatContext }
