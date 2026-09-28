import { batch, createContext, createEffect, createMemo, onCleanup, useContext } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { preloadFileIcons } from "@opencode-ai/ui/file-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import type { ParentProps } from "solid-js"
import { useDeviceSDK } from "./device-sdk"
import { useDeviceWorkspace } from "./device-workspace"
import { useLanguage } from "@/context/language"
import { DeviceHttpError, isBinaryFileError, isRuntimeDiffDisabledError, isRuntimeFileDisabledError, isRuntimeTreeDisabledError } from "@/client/device-transport"
import { FileContext } from "./file"
import { createPathHelpers } from "./file/path"
import { createFileTreeStore } from "./file/tree-store"
import { createDiffStore } from "./file/diff-store"
import { createRefreshScheduler } from "./file/refresh-scheduler"
import { createFileRefresh } from "./file/file-refresh"
import { invalidateFromHostWatcher } from "./file/watcher"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import type { FileContentChunk, FileMeta, FileState, FileViewState, SelectedLineRange } from "./file/types"

export { selectionFromLines } from "./file/types"
export type { FileSelection, SelectedLineRange, FileViewState, FileState } from "./file/types"
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error"
}

type DiffContextValue = ReturnType<typeof createDiffStore> & {
  scheduler: ReturnType<typeof createRefreshScheduler>
}

const DiffContext = createContext<DiffContextValue>()

export function useDiff() {
  const ctx = useContext(DiffContext)
  if (!ctx) throw new Error("useDiff must be used within DeviceFileProvider")
  return ctx
}

type TreePollingControls = {
  start: () => void
  stop: () => void
}

let treePollingRef: TreePollingControls | undefined

export function useTreePolling(): TreePollingControls {
  return treePollingRef ?? { start() {}, stop() {} }
}

type DeviceFileProviderProps = ParentProps & {
  visible?: () => boolean
}

export function DeviceFileProvider(props: DeviceFileProviderProps) {
  const device = useDeviceSDK()
  const workspace = useDeviceWorkspace()
  const language = useLanguage()
  preloadFileIcons()

  const scope = createMemo(() => device.directory)
  const path = createPathHelpers(scope)

  const inflight = new Map<string, Promise<void>>()
  const [store, setStore] = createStore<{
    file: Record<string, FileState>
  }>({
    file: {},
  })

  const refresh = createFileRefresh({
    normalize: path.normalize,
    getChunk: (file) => store.file[file]?.chunk,
    load: (file, opts) => void load(file, opts),
  })

  const tree = createFileTreeStore({
    scope,
    normalizeDir: path.normalizeDir,
    list: (dir) => device.client.runtime.fileList(dir || ".").then((x) => (x as unknown as import("@opencode-ai/sdk/v2").FileNode[] | undefined) ?? []),
    onError: (message) => {
      showToast({
        variant: "error",
        title: language.t("toast.file.listFailed.title"),
        description: message,
      })
    },
    isDisabledError: isRuntimeTreeDisabledError,
  })

  const diff = createDiffStore({
    scope,
    fetch: () => device.client.runtime.diff(),
    isDisabledError: isRuntimeDiffDisabledError,
  })

  const visible = props.visible ?? (() => true)

  const treeScheduler = createRefreshScheduler({
    visible,
    fetch: () => Promise.resolve(tree.refreshExpanded()),
  })

  const diffScheduler = createRefreshScheduler({
    visible,
    fetch: () => diff.load(),
  })

  treePollingRef = {
    start: () => treeScheduler.start(),
    stop: () => treeScheduler.stop(),
  }

  const evictContent = (keep?: Set<string>) => {
    evictContentLru(keep, (target) => {
      if (!store.file[target]) return
      setStore(
        "file",
        target,
        produce((draft) => {
          draft.content = undefined
          draft.loaded = false
        }),
      )
    })
  }

  createEffect(() => {
    scope()
    inflight.clear()
    refresh.cancelAll()
    resetFileContentLru()
    batch(() => {
      setStore("file", reconcile({}))
      tree.reset()
      diff.reset()
      treeScheduler.stop()
      diffScheduler.stop()
    })
  })

  const unsubscribe = workspace.subscribe((payload) => {
    const type = payload.type as string
    const props = (typeof payload.properties === "object" && payload.properties
      ? payload.properties
      : undefined) as Record<string, unknown> | undefined

    // Handle cs-cloud host events only
    if (type === "host.git.commit" || type === "host.git.status.changed" || type === "host.git.stash.changed") {
      if (diffScheduler.active && !diff.state().loading) {
        void diff.load()
        diffScheduler.touch()
      }
      treeScheduler.touch()
      return
    }

    if (type.startsWith("host.file.")) {
      invalidateFromHostWatcher(
        { type, properties: props },
        {
          normalize: path.normalize,
          hasFile: (f) => Boolean(store.file[f]),
          loadFile: (f) => void refresh.schedule(f),
          node: tree.node,
          isDirLoaded: tree.isLoaded,
          refreshDir: (d) => void tree.listDir(d, { force: true }),
        },
      )
      if (diffScheduler.active && !diff.state().loading) {
        void diff.load()
        diffScheduler.touch()
      }
      treeScheduler.touch()
      return
    }

    if (type === "file.edited") {
      const file = props?.file as string | undefined
      if (file) {
        const normalized = path.normalize(file)
        const parent = normalized.split("/").slice(0, -1).join("/")
        if (tree.isLoaded(parent)) {
          void tree.listDir(parent, { force: true })
        }
        if (store.file[normalized]) {
          void refresh.schedule(normalized)
        }
      }
      if (diffScheduler.active && !diff.state().loading) {
        void diff.load()
        diffScheduler.touch()
      }
      treeScheduler.touch()
      return
    }

    if (type === "session.diff") {
      if (diffScheduler.active && !diff.state().loading) {
        void diff.load()
        diffScheduler.touch()
      }
    }
  })

  const viewCache = createFileViewCache()
  const view = createMemo(() => viewCache.load(scope(), undefined))

  const ensure = (file: string) => {
    if (!file) return
    if (store.file[file]) return
    setStore("file", file, { path: file, name: getFilename(file) })
  }

  const setLoading = (file: string) => {
    setStore(
      "file",
      file,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )
  }

  const setLoaded = (file: string, content: FileState["content"], chunk?: FileContentChunk) => {
    setStore(
      "file",
      file,
      produce((draft) => {
        draft.loaded = true
        draft.loading = false
        draft.content = content
        draft.chunk = chunk
      }),
    )
  }

  const setMeta = (file: string, meta: FileMeta) => {
    setStore(
      "file",
      file,
      produce((draft) => {
        draft.meta = meta
      }),
    )
  }

  const setLoadError = (file: string, message: string) => {
    setStore(
      "file",
      file,
      produce((draft) => {
        draft.loading = false
        draft.error = message
      }),
    )
    showToast({
      variant: "error",
      title: language.t("toast.file.loadFailed.title"),
      description: message,
    })
  }

  const load = (input: string, options?: { force?: boolean; offset?: number; limit?: number }) => {
    const file = path.normalize(input)
    if (!file) return Promise.resolve()

    const directory = scope()
    const offset = options?.offset ?? 1
    const limit = options?.limit
    const key = `${directory}\n${file}\n${offset}\n${limit ?? "full"}`
    ensure(file)

    const current = store.file[file]
    if (!options?.force && current?.loaded && offset === 1 && limit == null) return Promise.resolve()

    const pending = inflight.get(key)
    if (pending) return pending

    setLoading(file)

    const metaPromise = current?.meta
      ? Promise.resolve(current.meta)
      : device.client.runtime.fileMeta(file).then((meta) => {
        if (scope() !== directory) return meta
        setMeta(file, meta)
        return meta
      }).catch(() => undefined)

    const promise = device.client.runtime
      .fileRead(file, { ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) })
      .then(async (x) => {
        if (scope() !== directory) return
        await metaPromise.catch(() => undefined)

        const previousContent = current?.content?.content ?? ""
        const nextContent = offset > 1 && previousContent
          ? `${previousContent}${x.content ?? ""}`
          : (x.content ?? "")

        const content = {
          type: x.type,
          content: nextContent,
        } as FileState["content"]

        setLoaded(file, content, {
          offset: x.offset,
          lines: x.lines,
          totalLines: x.totalLines,
        })

        if (!content) return
        touchFileContent(file, approxBytes(content))
        evictContent(new Set([file]))
      })
      .catch((e) => {
        if (scope() !== directory) return
        if (isRuntimeFileDisabledError(e)) {
          setStore(
            "file",
            file,
            produce((draft) => {
              draft.loading = false
              draft.loaded = true
              draft.filtered = { reason: "RUNTIME_FILE_DISABLED" }
            }),
          )
        } else if (isBinaryFileError(e)) {
          setStore(
            "file",
            file,
            produce((draft) => {
              draft.loading = false
              draft.errorKey = "file.preview.binaryUnsupported"
            }),
          )
        } else {
          setLoadError(file, errorMessage(e))
        }
      })
      .finally(() => {
        inflight.delete(key)
      })

    inflight.set(key, promise)
    return promise
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchAbort: AbortController | undefined
  let searchCancel: (() => void) | undefined
  const stopSearch = () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = undefined
    searchAbort?.abort()
    searchAbort = undefined
    searchCancel?.()
    searchCancel = undefined
  }
  const search = (query: string, dirs: "true" | "false") =>
    new Promise<string[]>((resolve) => {
      stopSearch()
      searchCancel = () => resolve([])
      const controller = new AbortController()
      searchAbort = controller
      searchTimer = setTimeout(() => {
        searchTimer = undefined
        const settle = (paths: string[]) => {
          if (searchAbort !== controller) return
          searchAbort = undefined
          searchCancel = undefined
          resolve(paths)
        }
        device.client.runtime.findFiles(query, dirs, controller.signal).then(
          (x) => settle(((x as string[] | undefined) ?? []).map(path.normalize)),
          () => settle([]),
        )
      }, 300)
    })

  const get = (input: string) => {
    const file = path.normalize(input)
    const state = store.file[file]
    const content = state?.content
    if (!content) return state
    if (hasFileContent(file)) {
      touchFileContent(file)
      return state
    }
    touchFileContent(file, approxBytes(content))
    return state
  }

  const diffContextValue: DiffContextValue = {
    ...diff,
    scheduler: diffScheduler,
  }

  onCleanup(() => {
    viewCache.clear()
    unsubscribe()
    treeScheduler.stop()
    diffScheduler.stop()
    treePollingRef = undefined
    stopSearch()
    refresh.cancelAll()
  })

  const value = {
    ready: () => view().ready(),
    normalize: path.normalize,
    tab: path.tab,
    pathFromTab: path.pathFromTab,
    tree: {
      list: tree.listDir,
      refresh: (input: string) => tree.listDir(input, { force: true }),
      state: tree.dirState,
      children: tree.children,
      expand: tree.expandDir,
      collapse: tree.collapseDir,
      isDisabled: tree.isDisabled,
      toggle(input: string) {
        if (tree.dirState(input)?.expanded) {
          tree.collapseDir(input)
          return
        }
        tree.expandDir(input)
      },
    },
    get,
    load,
    scrollTop: (input: string) => {
      const file = path.normalize(input)
      return view().scrollTop(file)
    },
    scrollLeft: (input: string) => {
      const file = path.normalize(input)
      return view().scrollLeft(file)
    },
    selectedLines: (input: string) => {
      const file = path.normalize(input)
      return view().selectedLines(file)
    },
    setScrollTop: (input: string, top: number) => {
      const file = path.normalize(input)
      view().setScrollTop(file, top)
    },
    setScrollLeft: (input: string, left: number) => {
      const file = path.normalize(input)
      view().setScrollLeft(file, left)
    },
    setSelectedLines: (input: string, range: SelectedLineRange | null) => {
      const file = path.normalize(input)
      view().setSelectedLines(file, range)
    },
    searchFiles: (query: string) => search(query, "false"),
    searchFilesAndDirectories: (query: string) => search(query, "true"),
    cancelSearch: stopSearch,
  }

  return (
    <DiffContext.Provider value={diffContextValue}>
      <FileContext.Provider value={value}>{props.children}</FileContext.Provider>
    </DiffContext.Provider>
  )
}
