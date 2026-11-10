import { afterEach, describe, expect, test, vi } from "vitest"

import { followAgentActivity } from "~/lib/agent-activity-stream"

vi.mock("~/lib/platform-api", () => ({
  getApiUrl: (path: string) => `https://api.test${path}`,
  getApiRequestHeaders: (headers: Record<string, string>) => headers,
}))

const SNAPSHOT = { agents: [], events: [], latestSeq: 0, serverTime: "2026-11-09T12:00:00.000Z" }

function streamResponse(): Response {
  const frame = `event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", snapshot: SNAPSHOT })}\n\n`
  return new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("followAgentActivity", () => {
  test("stops for good on 404, because the feature is off", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)
    const onConnection = vi.fn()
    await followAgentActivity({
      projectId: "p",
      signal: new AbortController().signal,
      onMessage: vi.fn(),
      onConnection,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onConnection).not.toHaveBeenCalled()
  })

  test("sends the session cookie and reconnects after a normal end", async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 2) controller.abort()
      return streamResponse()
    })
    vi.stubGlobal("fetch", fetchMock)
    const onMessage = vi.fn()
    const onConnection = vi.fn()
    await followAgentActivity({ projectId: "p", signal: controller.signal, onMessage, onConnection })
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(fetchMock.mock.calls[0]?.at(1)).toMatchObject({ credentials: "include" })
    expect(onMessage).toHaveBeenCalledWith({ type: "snapshot", snapshot: SNAPSHOT })
    expect(onConnection).toHaveBeenCalledWith("live")
  })

  test("warns only after 20 seconds of failures, and clears when a stream returns", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let healthy = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (healthy ? streamResponse() : new Response(null, { status: 503 }))),
    )
    const connections: string[] = []
    const running = followAgentActivity({
      projectId: "p",
      signal: controller.signal,
      onMessage: vi.fn(),
      onConnection: (connection) => connections.push(connection),
    })
    await vi.advanceTimersByTimeAsync(19_000)
    expect(connections).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(connections).toEqual(["reconnecting"])
    healthy = true
    await vi.advanceTimersByTimeAsync(31_000)
    expect(connections.at(-1)).toBe("live")
    controller.abort()
    await vi.runAllTimersAsync()
    await running
  })
})
