import { createContext, useContext } from "solid-js"
import type { DeviceClient } from "../client/device-client"
import { useDeviceSDK } from "./device-sdk"

export type ConversationAdapter = {
  sessionCreate: (body?: unknown) => Promise<{ data: unknown }>
  sessionAbort: (sessionID: string) => Promise<{ data: unknown }>
  sessionPromptAsync: (input: { sessionID: string } & Record<string, unknown>) => Promise<{ data: unknown }>
  sessionShell: (input: { sessionID: string } & Record<string, unknown>) => Promise<{ data: unknown }>
  sessionCommand: (input: { sessionID: string } & Record<string, unknown>) => Promise<{ data: unknown }>
  sessionGet: (sessionID: string) => Promise<{ data: unknown }>
  sessionUpdate: (input: { sessionID: string } & Record<string, unknown>) => Promise<{ data: unknown }>
  sessionDelete: (sessionID: string) => Promise<{ data: unknown }>
  sessionMessages: (sessionID: string, directory: string, limit: number) => Promise<{ data: unknown }>
  sessionTodo: (sessionID: string) => Promise<{ data: unknown }>
  sessionList: (directory?: string) => Promise<{ data: unknown }>
  sessionStatus: () => Promise<{ data: unknown }>
  health: () => Promise<{ data: unknown }>
  path: () => Promise<{ data: unknown }>
  sessionModes: () => Promise<{ data: unknown }>
  agentRuntimes: () => Promise<{ data: unknown }>
  worktreeCreate: (directory: string) => Promise<unknown>
  commands: () => Promise<{ data: unknown }>
  vcs: (directory: string) => Promise<{ data: unknown }>
  permissions: () => Promise<{ data: unknown }>
  questions: () => Promise<{ data: unknown }>
  questionReply: (requestID: string, answers: unknown) => Promise<{ data: unknown }>
  questionReject: (requestID: string) => Promise<{ data: unknown }>
  favoriteList: () => Promise<{ data: unknown }>
  favoriteLoad: (slug: string) => Promise<{ data: unknown }>
  favoriteUnload: (slug: string) => Promise<{ data: unknown }>
}

const ConversationAdapterContext = createContext<ConversationAdapter>()

export function useConversationAdapter() {
  const sdk = useDeviceSDK()
  return deviceAdapter(sdk.client)
}

export { ConversationAdapterContext }

export function deviceAdapter(client: DeviceClient): ConversationAdapter {
  const wrap = <T>(p: Promise<T>) => p.then((data) => ({ data })) as Promise<{ data: unknown }>

  return {
    health: () => wrap(client.runtime.health()),
    path: () => wrap(client.runtime.path()),
    sessionModes: () => wrap(client.agent.sessionModes()),
    agentRuntimes: () => wrap(client.agent.list()),
    sessionGet: (id) => wrap(client.conversation.get(id)),
    sessionList: (directory) => wrap(client.conversation.list(directory ? { directory } : undefined)),
    sessionMessages: (id, _directory, limit) => wrap(client.conversation.messages(id, { limit })),
    sessionStatus: () => wrap(client.conversation.status()),
    sessionTodo: (id) => wrap(client.conversation.todo(id)),
    sessionCreate: (body?: unknown) => wrap(client.conversation.create(body)),
    sessionUpdate: (input) => wrap(client.conversation.update(input.sessionID, input)),
    sessionDelete: (id) => wrap(client.conversation.delete(id)),
    sessionAbort: (id) => wrap(client.conversation.abort(id)),
    sessionShell: (input) => wrap(client.conversation.shell(input.sessionID, input)),
    sessionCommand: (input) => wrap(client.conversation.command(input.sessionID, input)),
    sessionPromptAsync: (input) => wrap(client.conversation.promptAsync(input.sessionID, input)),
    worktreeCreate: () => Promise.resolve(undefined),
    commands: () => client.transport.get<Array<{ name: string; aliases?: string[]; title?: string; description?: string; scope?: string; category?: string; keybind?: string; source?: string; template?: string; subtask?: boolean; hints?: string[] }>>("/api/v1/agents/commands").then((data) => ({ data: data ?? [] })),
    vcs: () => wrap(client.runtime.vcs()),
    permissions: () => wrap(client.permission.list()),
    questions: () => wrap(client.question.list()),
    questionReply: (id, answers) => wrap(client.question.reply(id, { answers })),
    questionReject: (id) => wrap(client.question.reject(id)),
    favoriteList: () => client.transport.get("/api/v1/agents/favorites").then((data) => ({ data: data ?? [] })),
    favoriteLoad: (slug) => client.transport.post(`/api/v1/agents/favorites/${slug}/load`).then((data) => ({ data })),
    favoriteUnload: (slug) => client.transport.post(`/api/v1/agents/favorites/${slug}/unload`).then((data) => ({ data })),
  }
}
