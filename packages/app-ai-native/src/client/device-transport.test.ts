import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { registerRateLimitToast, RateLimitToastTesting } from "@/lib/rate-limit-toast"

let createDeviceTransport: typeof import("./device-transport").createDeviceTransport
let DeviceHttpError: typeof import("./device-transport").DeviceHttpError

const onUnauthorized = mock(() => {})

beforeAll(async () => {
  mock.module("@/lib/session-expired", () => ({ onUnauthorized }))
  ;({ createDeviceTransport, DeviceHttpError } = await import("./device-transport"))
})

const originalFetch = globalThis.fetch

function respond(status: number, body: unknown = { message: "err" }) {
  globalThis.fetch = ((() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as unknown) as typeof fetch
}

describe("createDeviceTransport status handling", () => {
  const show = mock(() => {})

  beforeEach(() => {
    RateLimitToastTesting.reset()
    show.mockClear()
    onUnauthorized.mockClear()
    registerRateLimitToast(show)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    RateLimitToastTesting.reset()
  })

  test("429 triggers the rate-limit toast and throws", async () => {
    respond(429)
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    await expect(transport.get("/x")).rejects.toBeInstanceOf(DeviceHttpError)
    expect(show).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  test("401 triggers onUnauthorized instead of the rate-limit toast", async () => {
    respond(401)
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    await expect(transport.get("/x")).rejects.toBeInstanceOf(DeviceHttpError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(show).not.toHaveBeenCalled()
  })

  test("successful response triggers neither handler", async () => {
    respond(200, { ok: true, data: { foo: "bar" } })
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    const result = await transport.get("/x")
    expect(result).toEqual({ foo: "bar" })
    expect(show).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  test("getResponse preserves response headers", async () => {
    globalThis.fetch = ((() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, data: [{ id: "message-1" }] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Next-Cursor": "cursor-1",
          },
        }),
      )) as unknown) as typeof fetch
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    const result = await transport.getResponse("/x")
    expect(result.data).toEqual([{ id: "message-1" }])
    expect(result.response.headers.get("X-Next-Cursor")).toBe("cursor-1")
  })

  test("other error statuses trigger neither handler", async () => {
    respond(500)
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    await expect(transport.get("/x")).rejects.toBeInstanceOf(DeviceHttpError)
    expect(show).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  test("429 triggers the toast only once across rapid requests", async () => {
    respond(429)
    const transport = createDeviceTransport({ baseUrl: "https://test.local" })

    await expect(transport.get("/a")).rejects.toBeInstanceOf(DeviceHttpError)
    await expect(transport.get("/b")).rejects.toBeInstanceOf(DeviceHttpError)
    await expect(transport.get("/c")).rejects.toBeInstanceOf(DeviceHttpError)
    expect(show).toHaveBeenCalledTimes(1)
  })
})
