import { describe, expect, test } from "bun:test"
import { patchFile, patchFiles } from "./apply-patch-file"
import { text } from "./session-diff"

describe("apply patch file", () => {
  test("parses patch metadata from the server", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        patch:
          "Index: a.ts\n===================================================================\n--- a.ts\t\n+++ a.ts\t\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.fileDiff.name).toBe("a.ts")
    expect(text(file!.view, "deletions")).toBe("one\ntwo\n")
    expect(text(file!.view, "additions")).toBe("one\nthree\n")
  })

  test("keeps legacy before and after payloads working", () => {
    const file = patchFiles([
      {
        filePath: "/tmp/a.ts",
        relativePath: "a.ts",
        type: "update",
        before: "one\n",
        after: "two\n",
        additions: 1,
        deletions: 1,
      },
    ])[0]

    expect(file).toBeDefined()
    expect(file?.view.patch).toContain("@@ -1,1 +1,1 @@")
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("infers update from a raw unified diff", () => {
    const file = patchFile({
      path: "src/a.ts",
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+two\n",
    })

    expect(file?.type).toBe("update")
    expect(text(file!.view, "deletions")).toBe("one\n")
    expect(text(file!.view, "additions")).toBe("two\n")
  })

  test("infers add and delete from old/new string aliases", () => {
    const added = patchFile({ path: "new.txt", new_string: "new\n" })
    const deleted = patchFile({ file: "old.txt", old_text: "old\n" })

    expect(added?.type).toBe("add")
    expect(text(added!.view, "additions")).toBe("new\n")
    expect(deleted?.type).toBe("delete")
    expect(text(deleted!.view, "deletions")).toBe("old\n")
  })

  test("accepts a wrapped files payload and snake_case move paths", () => {
    const file = patchFiles({
      files: [
        {
          path: "a.txt",
          kind: { type: "update", move_path: "b.txt" },
          patch: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    })[0]

    expect(file?.type).toBe("move")
    expect(file?.movePath).toBe("b.txt")
    expect(text(file!.view, "deletions")).toBe("old\n")
    expect(text(file!.view, "additions")).toBe("new\n")
  })
})