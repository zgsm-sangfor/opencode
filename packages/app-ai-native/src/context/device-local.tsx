import { createContext, useContext, type ParentProps } from "solid-js"
import { batch, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useDeviceSDK } from "./device-sdk"
import { useDeviceWorkspace } from "./device-workspace"
import { base64Encode } from "@opencode-ai/util/encode"
import type { ProviderCapability, ProviderCapabilityModel } from "./global-sync/types"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"

type ModelKey = { providerID: string; modelID: string }

type ModelInfo = ProviderCapabilityModel & {
  provider: { id: string; name: string }
  latest?: boolean
}

type AgentInfo = {
  name: string
  mode?: string
  hidden?: boolean
  model?: ModelKey
  variant?: string
}

type DeviceLocalValue = {
  slug: () => string
  activeSessionID: () => string | undefined
  setActiveSession: (sessionID: string | undefined) => void
  onSessionCreated: () => (((input: { sessionID: string; title?: string }) => void) | undefined)
  navigateBack: () => (() => void) | undefined
  setOnSessionCreated: (fn: ((input: { sessionID: string; title?: string }) => void) | undefined) => void
  setNavigateBack: (fn: (() => void) | undefined) => void

  agent: {
    list: () => AgentInfo[]
    current: () => AgentInfo | undefined
    set: (name: string | undefined) => void
    move: (direction: 1 | -1) => void
  }
  model: {
    ready: () => boolean
    current: () => ModelInfo | undefined
    set: (model: ModelKey | undefined) => void
    list: () => ModelInfo[]
    recent: () => ModelInfo[]
    cycle: (direction: 1 | -1) => void
    visible: (model: ModelKey) => boolean
    setVisibility: (model: ModelKey, visible: boolean) => void
    variant: {
      configured: () => string | undefined
      selected: () => string | null | undefined
      current: () => string | undefined
      list: () => string[]
      set: (value: string | undefined) => void
      cycle: () => void
    }
  }
}

const DeviceLocalContext = createContext<DeviceLocalValue>()

export function useDeviceLocal() {
  const ctx = useContext(DeviceLocalContext)
  if (!ctx) throw new Error("useDeviceLocal must be used within DeviceLocalProvider")
  return ctx
}

export { DeviceLocalContext }

export function DeviceLocalProvider(props: ParentProps<{ workspaceId?: string }>) {
  const device = useDeviceSDK()
  const sync = useDeviceWorkspace()

  const modelKey = () => `opencode.device.model.${props.workspaceId ?? base64Encode(device.directory)}`
  const variantKey = () =>
    `opencode.device.modelVariants.${props.workspaceId ?? base64Encode(device.directory)}`

  const loadModel = () => {
    try {
      const raw = localStorage.getItem(modelKey())
      if (raw) return JSON.parse(raw) as ModelKey
    } catch {}
  }

  function saveModel(model: ModelKey | undefined) {
    try {
      if (model) localStorage.setItem(modelKey(), JSON.stringify(model))
      else localStorage.removeItem(modelKey())
    } catch {}
  }

  const loadVariants = () => {
    try {
      const raw = localStorage.getItem(variantKey())
      if (raw) return JSON.parse(raw) as Record<string, string | null>
    } catch {}
    return {} as Record<string, string | null>
  }

  const sessionAgentsKey = () => `opencode.device.sessionAgents.${props.workspaceId ?? base64Encode(device.directory)}`

  const sessionAgents = (() => {
    try {
      const raw = localStorage.getItem(sessionAgentsKey())
      if (raw) return JSON.parse(raw) as Record<string, string>
    } catch {}
    return {} as Record<string, string>
  })()

  function saveSessionAgents() {
    try {
      localStorage.setItem(sessionAgentsKey(), JSON.stringify(sessionAgents))
    } catch {}
  }

  const cached = loadModel()
  const cachedVariants = loadVariants()

  const [activeSessionID, setActiveSessionID] = createSignal<string | undefined>()
  let _onSessionCreated: ((input: { sessionID: string; title?: string }) => void) | undefined
  let _navigateBack: (() => void) | undefined
  const onSessionCreated = () => _onSessionCreated
  const navigateBack = () => _navigateBack
  const setOnSessionCreated = (fn: typeof _onSessionCreated) => { _onSessionCreated = fn }
  const setNavigateBack = (fn: typeof _navigateBack) => { _navigateBack = fn }

  const [store, setStore] = createStore<{
    currentAgent: string | undefined
    currentModel: ModelKey | undefined
    variants: Record<string, string | null>
  }>({
    currentAgent: undefined,
    currentModel: cached ? { ...cached } : undefined,
    variants: cachedVariants,
  })

  function saveVariants() {
    try {
      localStorage.setItem(variantKey(), JSON.stringify(store.variants))
    } catch {}
  }

  const setActiveSession = (sessionID: string | undefined) => {
    const prev = activeSessionID()
    if (prev === sessionID) return
    setActiveSessionID(sessionID)
    const cachedAgent = sessionID ? sessionAgents[sessionID] : undefined
    if (cachedAgent) {
      setStore("currentAgent", cachedAgent)
    } else if (!prev && sessionID && store.currentAgent) {
      sessionAgents[sessionID] = store.currentAgent
      saveSessionAgents()
    } else {
      setStore("currentAgent", undefined)
    }
  }

  const agentList = createMemo(() =>
    (sync.data.agent as any[]).filter((x) => x.mode !== "subagent" && !x.hidden),
  )

  const currentAgent = createMemo(() => {
    const list = agentList()
    if (list.length === 0) return undefined
    if (store.currentAgent) {
      const found = list.find((x) => x.name === store.currentAgent)
      if (found) return found
    }
    return list[0]
  })

  const setAgent = (name: string | undefined) => {
    const list = agentList()
    if (list.length === 0) {
      setStore("currentAgent", undefined)
      return
    }
    const match = name ? list.find((x) => x.name === name) : undefined
    const value = match ?? list[0]
    if (!value) return
    batch(() => {
      setStore("currentAgent", value.name)
      const sid = activeSessionID()
      if (sid) {
        sessionAgents[sid] = value.name
        saveSessionAgents()
      }
      if (value.model && value.model.providerID) {
        setModel(value.model)
      }
    })
  }

  const moveAgent = (direction: 1 | -1) => {
    const list = agentList()
    if (list.length === 0) return
    let next = list.findIndex((x) => x.name === store.currentAgent) + direction
    if (next < 0) next = list.length - 1
    if (next >= list.length) next = 0
    setAgent(list[next]?.name)
  }

  const modelList = createMemo<ModelInfo[]>(() => {
    const providers = sync.data.provider.connected as ProviderCapability[]
    if (!providers?.length) return []
    return providers.flatMap((p) =>
      Object.values(p.models).map((m) => ({
        ...m,
        provider: { id: p.id, name: p.name },
      })),
    )
  })

  const resolveModel = (providers: ProviderCapability[], key: ModelKey): ModelInfo | undefined => {
    const provider = providers.find((p) => p.id === key.providerID)
    const m = provider?.models[key.modelID]
    if (m) return { ...m, provider: { id: provider.id, name: provider.name } }
    return undefined
  }

  const fallbackModel = (providers: ProviderCapability[]): ModelInfo | undefined => {
    for (const p of providers) {
      if (p.default_model) {
        const m = p.models[p.default_model]
        if (m) return { ...m, provider: { id: p.id, name: p.name } }
      }
      const first = Object.values(p.models)[0]
      if (first) return { ...first, provider: { id: p.id, name: p.name } }
    }
    return undefined
  }

  const currentModel = createMemo<ModelInfo | undefined>(() => {
    const providers = sync.data.provider.connected as ProviderCapability[]
    if (!providers?.length) return undefined
    if (store.currentModel) {
      const resolved = resolveModel(providers, store.currentModel)
      if (resolved) return resolved
    }
    return fallbackModel(providers)
  })

  const setModel = (model: ModelKey | undefined) => {
    const next = model && model.providerID ? { ...model } : undefined
    setStore("currentModel", next)
    saveModel(next)
  }

  const modelSlot = (model: ModelInfo) => `${model.provider.id}/${model.id}`
  const variantList = () => Object.keys(currentModel()?.variants ?? {})
  const variantSelected = () => {
    const model = currentModel()
    if (!model) return undefined
    return store.variants[modelSlot(model)]
  }
  const variantConfigured = () => {
    const agent = currentAgent()
    const model = currentModel()
    if (!agent || !model) return undefined
    return getConfiguredAgentVariant({
      agent: { model: agent.model, variant: agent.variant },
      model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
    })
  }
  const variantCurrent = () =>
    resolveModelVariant({
      variants: variantList(),
      selected: variantSelected(),
      configured: variantConfigured(),
    })
  const variantSet = (value: string | undefined) => {
    const model = currentModel()
    if (!model) return
    setStore("variants", modelSlot(model), value ?? null)
    saveVariants()
  }

  const value: DeviceLocalValue = {
    slug: () => base64Encode(device.directory),
    activeSessionID,
    setActiveSession,
    onSessionCreated: onSessionCreated,
    navigateBack: navigateBack,
    setOnSessionCreated,
    setNavigateBack,
    agent: {
      list: agentList,
      current: currentAgent,
      set: setAgent,
      move: moveAgent,
    },
    model: {
      ready: () => sync.data.status !== "loading",
      current: currentModel,
      set: setModel,
      list: modelList,
      recent: () => [],
      cycle: () => {},
      visible: () => true,
      setVisibility: () => {},
      variant: {
        configured: variantConfigured,
        selected: variantSelected,
        current: variantCurrent,
        list: variantList,
        set: variantSet,
        cycle() {
          const items = variantList()
          if (items.length === 0) return
          variantSet(
            cycleModelVariant({
              variants: items,
              selected: variantSelected(),
              configured: variantConfigured(),
            }),
          )
        },
      },
    },
  }

  return <DeviceLocalContext.Provider value={value}>{props.children}</DeviceLocalContext.Provider>
}
