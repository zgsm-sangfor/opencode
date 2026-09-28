export type ViewDiff = {
  fileDiff: { name: string }
  patch: string
  deletions: string
  additions: string
}

function extractFromPatch(patch: string, kind: "deletions" | "additions"): string {
  const lines = patch.split("\n")
  let inHunk = false
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line === "" && i === lines.length - 1) continue
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("---") || line.startsWith("+++")) continue
    if (line.startsWith("\\")) continue

    if (kind === "deletions") {
      if (line.startsWith("-")) {
        result.push(line.slice(1))
      } else if (!line.startsWith("+")) {
        result.push(line.startsWith(" ") ? line.slice(1) : line)
      }
    } else {
      if (line.startsWith("+")) {
        result.push(line.slice(1))
      } else if (!line.startsWith("-")) {
        result.push(line.startsWith(" ") ? line.slice(1) : line)
      }
    }
  }

  if (result.length === 0) return ""
  return result.join("\n") + "\n"
}

function generateUnifiedDiff(file: string, before: string, after: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")

  if (beforeLines[beforeLines.length - 1] === "") beforeLines.pop()
  if (afterLines[afterLines.length - 1] === "") afterLines.pop()

  const oldCount = beforeLines.length
  const newCount = afterLines.length

  const header = `Index: ${file}\n===================================================================\n--- ${file}\n+++ ${file}\n`

  if (oldCount === 0 && newCount === 0) {
    return header + `@@ -0,0 +0,0 @@\n`
  }

  const hunk = `@@ -1,${oldCount} +1,${newCount} @@\n`
  const oldLines = beforeLines.map((l) => `-${l}`).join("\n")
  const newLines = afterLines.map((l) => `+${l}`).join("\n")

  return header + hunk + oldLines + "\n" + newLines + "\n"
}

export function normalize(input: {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status: string
}): ViewDiff {
  if (input.patch) {
    return {
      fileDiff: { name: input.file },
      patch: input.patch,
      deletions: extractFromPatch(input.patch, "deletions"),
      additions: extractFromPatch(input.patch, "additions"),
    }
  }

  const before = input.before ?? ""
  const after = input.after ?? ""
  const patch = generateUnifiedDiff(input.file, before, after)

  return {
    fileDiff: { name: input.file },
    patch,
    deletions: before,
    additions: after,
  }
}

export function text(view: ViewDiff, kind: "deletions" | "additions"): string {
  return view[kind]
}
