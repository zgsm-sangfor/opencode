import { type ParentProps } from "solid-js"
import { useDeviceSDK } from "./device-sdk"
import { useDeviceWorkspace } from "./device-workspace"
import { useDeviceSessionStore } from "./device-session"
import { useDeviceLocal } from "./device-local"
import { SessionChatProvider, type SessionChatBackend } from "./session-chat"
import { useConversationAdapter } from "./device-adapter"

export function DeviceSessionChatProvider(props: ParentProps) {
  const device = useDeviceSDK()
  const workspace = useDeviceWorkspace()
  const store = useDeviceSessionStore()
  const local = useDeviceLocal()
  const adapter = useConversationAdapter()

  const backend: SessionChatBackend = {
    directory: () => device.directory,
    workspaceId: () => workspace.workspaceId,
    workspaceStatus: () => workspace.data.status,

    sessions: () => workspace.data.session,
    sessionTotal: () => workspace.data.sessionTotal,
    sessionStatus: (id) => workspace.data.sessionStatus[id] ?? ({ type: "idle" } as any),

    agents: () => workspace.data.agent,
    commands: () => workspace.data.command,
    providerCaps: () => workspace.data.provider,
    permissions: () => workspace.data.permissions,
    questions: () => workspace.data.questions,
    vcs: () => workspace.data.vcs,
    vcsLoad: () => workspace.vcs.load().then(() => {}),

    agentAvailable: () => workspace.agentAvailable(),
    capabilities: () => workspace.capabilities(),

    messages: (id) => store.data.messages[id] ?? [],
    parts: () => store.data.parts,
    messageParts: (messageId) => store.data.parts[messageId] ?? [],
    partProgress: () => store.data.partProgress,
    todos: (id) => store.data.todos[id] ?? [],

    loadMessages: (id) => store.loadMessages(id),
    loadTodo: (id) => store.todo(id),
    historyMore: (id) => store.historyMore(id),
    historyLoading: (id) => store.historyLoading(id),
    historyLoadMore: (id) => store.historyLoadMore(id),
    clearUnread: (id) => workspace.session.clearUnread(id),

    getSession: (id) => workspace.session.get(id),
    renameSession: (id, title) =>
      adapter.sessionUpdate({ sessionID: id, title }).then(() => {
        workspace.session.patch(id, { title })
      }),
    deleteSession: (id) =>
      adapter
        .sessionDelete(id)
        .then((x) => {
          const ok = !!x.data
          if (ok) workspace.session.removeLocal(id)
          return ok
        })
        .catch(() => false),

    permissionRespond: (id, decision) =>
      device.client.permission.respond(id, { decision }).then(() => {}),
    removePermission: (sessionId, permId) =>
      workspace.session.removePermission(sessionId, permId),
    removeQuestion: (sessionId, requestId) =>
      workspace.session.removeQuestion(sessionId, requestId),

    autoAccept: {
      enabled: () => workspace.autoAccept.enabled(),
      enable: () => workspace.autoAccept.enable(),
    },

    agent: {
      current: () => local.agent.current(),
      set: (name) => local.agent.set(name),
    },
    model: {
      current: () => local.model.current(),
      set: (key) => local.model.set(key),
      ready: () => local.model.ready(),
    },

    activeSessionID: () => local.activeSessionID(),
    setActiveSession: (id) => local.setActiveSession(id),
    setOnSessionCreated: (fn) => local.setOnSessionCreated(fn),
    navigateBack: () => local.navigateBack(),
    setNavigateBack: (fn) => local.setNavigateBack(fn),

    findSessionName: (id) =>
      workspace.data.session.find((s) => s.id === id)?.title ?? id.slice(0, 8),
  }

  return (
    <SessionChatProvider value={backend}>
      {props.children}
    </SessionChatProvider>
  )
}
