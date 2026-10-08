import { expect, test } from "bun:test"
import { hasDirectory, relativize } from "./path"

test("hasDirectory handles both path separators", () => {
  expect(hasDirectory("src/file.ts")).toBe(true)
  expect(hasDirectory("src\\file.ts")).toBe(true)
  expect(hasDirectory("file.ts")).toBe(false)
  expect(hasDirectory(undefined)).toBe(false)
})

test("relativize strips the workspace path across separators", () => {
  expect(relativize("D:\\repo\\src\\file.ts", "D:\\repo")).toBe("src/file.ts")
  expect(relativize("D:/repo/src/", "D:\\repo")).toBe("src/")
  expect(relativize("/repo/src/file.ts", "/repo")).toBe("src/file.ts")
  expect(relativize("D:\\other\\file.ts", "D:\\repo")).toBe("D:\\other\\file.ts")
})
