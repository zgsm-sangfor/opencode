import { normalize, type ViewDiff } from "./session-diff"

type Kind = "add" | "update" | "delete" | "move"

type Raw = Record<string, unknown>

export type ApplyPatchFile = {
  filePath: string
  relativePath: string
  type: Kind
  additions: number
  deletions: number
  movePath?: string
  view: ViewDiff
}

function kind(value: unknown): Kind | undefined {
  if (value === "add" || value === "update" || value === "delete" || value === "move") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return kind((value as Record<string, unknown>).type)
  }
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function firstString(value: Raw, keys: string[]) {
  for (const key of keys) {
    const next = string(value[key])
    if (next !== undefined) return next
  }
}

function firstNumber(value: Raw, keys: string[]) {
  for (const key of keys) {
    if (typeof value[key] === "number") return value[key] as number
  }
}

function inferKind(input: {
  type?: Kind
  patch?: string
  before?: string
  after?: string
  movePath?: string
}): Kind | undefined {
  if (input.movePath) return "move"
  if (input.type) return input.type
  if (input.before === undefined && input.after !== undefined) return "add"
  if (input.before !== undefined && input.after === undefined) return "delete"
  if (input.patch !== undefined) {
    if (/^---\s+\/dev\/null\s*$/m.test(input.patch)) return "add"
    if (/^\+\+\+\s+\/dev\/null\s*$/m.test(input.patch)) return "delete"
  }
  if (input.patch !== undefined || input.before !== undefined || input.after !== undefined) return "update"
}

function isUnifiedDiff(value: string) {
  return /^@@\s/m.test(value) || /^---\s.+\n\+\+\+\s/m.test(value)
}

function status(type: Kind): "added" | "deleted" | "modified" {
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

export function patchFile(raw: unknown): ApplyPatchFile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return

  const value = raw as Raw
  const filePath = firstString(value, [
    "filePath",
    "relativePath",
    "path",
    "file",
    "filename",
    "fileName",
  ])
  const relativePath =
    firstString(value, ["relativePath", "filePath", "path", "file", "filename", "fileName"]) ?? filePath
  const rawKind = value.type ?? value.kind
  const nestedKind = rawKind && typeof rawKind === "object" && !Array.isArray(rawKind)
    ? (rawKind as Raw)
    : undefined
  const movePath =
    firstString(value, ["movePath", "move_path"]) ??
    (nestedKind ? firstString(nestedKind, ["movePath", "move_path"]) : undefined)
  let patch = firstString(value, ["patch", "diff", "unifiedDiff", "unified_diff"])
  let before = firstString(value, ["before", "oldString", "old_string", "oldText", "old_text"])
  let after = firstString(value, ["after", "newString", "new_string", "newText", "new_text"])
  const type = inferKind({
    type: kind(rawKind),
    patch,
    before,
    after,
    movePath,
  })

  // Some agents call add/delete content a "diff" rather than a unified patch.
  // Keep the agent's content, but route it to the side the renderer expects.
  if (type === "add" && after === undefined && patch !== undefined && !isUnifiedDiff(patch)) {
    after = patch
    patch = undefined
  }
  if (type === "delete" && before === undefined && patch !== undefined && !isUnifiedDiff(patch)) {
    before = patch
    patch = undefined
  }

  if (!type || !filePath || !relativePath) return
  if (patch === undefined && before === undefined && after === undefined) return

  const additions = firstNumber(value, ["additions"]) ?? 0
  const deletions = firstNumber(value, ["deletions"]) ?? 0

  return {
    filePath,
    relativePath,
    type,
    additions,
    deletions,
    movePath,
    view: normalize({
      file: relativePath,
      patch,
      before,
      after,
      additions,
      deletions,
      status: status(type),
    }),
  }
}

export function patchFiles(raw: unknown) {
  const input = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).files)
      ? ((raw as Record<string, unknown>).files as unknown[])
      : raw === undefined || raw === null
        ? []
        : [raw]
  return input.map(patchFile).filter((file): file is ApplyPatchFile => !!file)
}
