import {
  generationStreamMessageSchema,
  type GenerationStreamMessage,
} from "@doxahq/contracts"

import { getApiRequestHeaders, getApiUrl } from "~/lib/platform-api"

const MAX_SSE_BUFFER_LENGTH = 1_048_576
const GENERATION_STREAM_SILENCE_TIMEOUT_MS = 30_000

interface GenerationStreamCallbacks {
  onMessage: (message: GenerationStreamMessage, eventId: number | null) => void
}

interface SseFrame {
  event: string | null
  data: string
  id: string | null
}

export class GenerationStreamRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "GenerationStreamRequestError"
  }
}

export interface GenerationStreamWatchdog {
  receivedMessage: () => void
  stop: () => void
}

export function createGenerationStreamWatchdog(
  onSilence: () => void,
): GenerationStreamWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null

  function stop(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  return {
    receivedMessage(): void {
      stop()
      timer = setTimeout(() => {
        timer = null
        onSilence()
      }, GENERATION_STREAM_SILENCE_TIMEOUT_MS)
    },
    stop,
  }
}

export async function streamProjectGeneration(input: {
  projectId: string
  generationId: string
  afterSequence: number
  signal: AbortSignal
  callbacks: GenerationStreamCallbacks
}): Promise<void> {
  const searchParams = new URLSearchParams({ after: String(input.afterSequence) })
  const response = await fetch(
    getApiUrl(
      `/projects/${encodeURIComponent(input.projectId)}/generations/${encodeURIComponent(input.generationId)}/stream?${searchParams.toString()}`,
    ),
    {
      credentials: "include",
      headers: getApiRequestHeaders({ accept: "text/event-stream" }),
      signal: input.signal,
    },
  )

  if (!response.ok) {
    throw new GenerationStreamRequestError(
      `Generation stream request failed (${response.status}).`,
      response.status,
    )
  }

  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new GenerationStreamRequestError("Generation stream returned an invalid response.", response.status)
  }

  if (!response.body) {
    throw new GenerationStreamRequestError("Streaming responses are not supported in this browser.", null)
  }

  const parser = createSseParser((frame) => {
    const payload = parseGenerationStreamFrame(frame)
    input.callbacks.onMessage(payload, parseEventId(frame.id))
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      parser.push(decoder.decode(result.value, { stream: true }))
    }

    parser.push(decoder.decode())
    parser.finish()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export function createSseParser(onFrame: (frame: SseFrame) => void) {
  let buffer = ""

  function drain(): void {
    while (true) {
      const separator = findFrameSeparator(buffer)
      if (!separator) return

      const frameText = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator.length)
      if (frameText.trim()) onFrame(parseSseFrame(frameText))
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
        throw new GenerationStreamRequestError("Generation stream frame exceeded the size limit.", null)
      }
      drain()
    },
    finish(): void {
      if (buffer.trim()) onFrame(parseSseFrame(buffer))
      buffer = ""
    },
  }
}

function findFrameSeparator(value: string): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value)
  return match ? { index: match.index, length: match[0].length } : null
}

function parseSseFrame(frame: string): SseFrame {
  let event: string | null = null
  let id: string | null = null
  const data: string[] = []

  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue

    const separatorIndex = line.indexOf(":")
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex)
    const rawValue = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1)
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue

    if (field === "event") event = value
    if (field === "id" && !value.includes("\0")) id = value
    if (field === "data") data.push(value)
  }

  return { event, id, data: data.join("\n") }
}

function parseGenerationStreamFrame(frame: SseFrame): GenerationStreamMessage {
  if (frame.event === "error") {
    throw new GenerationStreamRequestError("Generation stream was interrupted.", null)
  }

  let payload: unknown
  try {
    payload = JSON.parse(frame.data)
  } catch {
    throw new GenerationStreamRequestError("Generation stream returned malformed data.", null)
  }

  const result = generationStreamMessageSchema.safeParse(payload)
  if (!result.success || (frame.event && frame.event !== result.data.type)) {
    throw new GenerationStreamRequestError("Generation stream returned an invalid event.", null)
  }

  return result.data
}

function parseEventId(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const eventId = Number(value)
  return Number.isSafeInteger(eventId) ? eventId : null
}
