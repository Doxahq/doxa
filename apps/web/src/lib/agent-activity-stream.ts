import {
  agentActivityStreamMessageSchema,
  type AgentActivityStreamMessage,
} from "@doxahq/contracts/agent-live-activity"

import {
  createGenerationStreamWatchdog,
  createSseParser,
  GenerationStreamRequestError,
} from "~/lib/generation-stream"
import { getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

export type AgentActivityConnection = "connecting" | "live" | "reconnecting"

/** The dashboard shows no warning for a short drop, such as a deploy. */
const RECONNECTING_AFTER_MS = 20_000
const NORMAL_RECONNECT_MS = 1_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const
/** These answers do not change on a retry. */
const FINAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 404])

async function readAgentActivityStream(input: {
  projectId: string
  signal: AbortSignal
  onMessage: (message: AgentActivityStreamMessage) => void
}): Promise<void> {
  const response = await fetch(
    getApiUrl(`/projects/${encodeURIComponent(input.projectId)}/agent-activity/stream`),
    {
      credentials: "include",
      headers: getApiRequestHeaders({ accept: "text/event-stream" }),
      signal: input.signal,
    },
  )
  if (!response.ok || !response.body) {
    throw new GenerationStreamRequestError(`Agent activity stream failed (${response.status}).`, response.status)
  }
  const parser = createSseParser((frame) => {
    input.onMessage(agentActivityStreamMessageSchema.parse(JSON.parse(frame.data)))
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
    }
    parser.push(decoder.decode())
    parser.finish()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Never zero: a server that ends each stream at once must not cause a tight loop. */
function reconnectDelay(failures: number): number {
  if (failures === 0) return NORMAL_RECONNECT_MS
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] ?? NORMAL_RECONNECT_MS
}

function isFinalFailure(cause: unknown): boolean {
  return cause instanceof GenerationStreamRequestError && cause.status !== null && FINAL_STATUSES.has(cause.status)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Keeps one stream open until `signal` aborts. The server ends each stream
 * after a few minutes, so that a reconnect checks access again. That normal
 * end reconnects after a short pause, and only a failure backs off and warns.
 */
export async function followAgentActivity(input: {
  projectId: string
  signal: AbortSignal
  onMessage: (message: AgentActivityStreamMessage) => void
  onConnection: (connection: AgentActivityConnection) => void
}): Promise<void> {
  let failures = 0
  let warningTimer: ReturnType<typeof setTimeout> | null = null
  const clearWarning = () => {
    if (warningTimer !== null) clearTimeout(warningTimer)
    warningTimer = null
  }
  input.signal.addEventListener("abort", clearWarning, { once: true })

  while (!input.signal.aborted) {
    const attempt = new AbortController()
    const stopAttempt = () => attempt.abort()
    input.signal.addEventListener("abort", stopAttempt, { once: true })
    const watchdog = createGenerationStreamWatchdog(stopAttempt)
    try {
      await readAgentActivityStream({
        projectId: input.projectId,
        signal: attempt.signal,
        onMessage: (message) => {
          watchdog.receivedMessage()
          failures = 0
          clearWarning()
          input.onConnection("live")
          input.onMessage(message)
        },
      })
    } catch (cause) {
      if (input.signal.aborted || isFinalFailure(cause)) return
      failures += 1
    } finally {
      watchdog.stop()
      input.signal.removeEventListener("abort", stopAttempt)
    }
    if (failures > 0) {
      warningTimer ??= setTimeout(() => input.onConnection("reconnecting"), RECONNECTING_AFTER_MS)
    }
    await wait(reconnectDelay(failures), input.signal)
  }
}
