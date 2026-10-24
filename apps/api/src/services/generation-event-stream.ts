import type { GenerationJobDto, GenerationStreamMessage } from "@doxahq/contracts";
import type { SSEStreamingApi } from "hono/streaming";
import type { Env } from "../env";
import { isLocalOrigin } from "../http/access";
import { JobsRepository, type GenerationStreamState } from "../repositories/jobs";
import { toGenerationLogEvent } from "./generation-log";

const EVENT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_TERMINAL_GRACE_MS = 2_000;
const DEFAULT_MAX_DURATION_MS = 10 * 60_000;

interface GenerationStreamSettings {
  pollIntervalMs: number;
  heartbeatMs: number;
  terminalGraceMs: number;
  maxDurationMs: number;
}

export function parseGenerationStreamCursor(request: Request): number | null {
  const rawCursor = request.headers.get("last-event-id")
    ?? new URL(request.url).searchParams.get("after")
    ?? "0";

  if (!/^\d+$/.test(rawCursor)) return null;

  const cursor = Number(rawCursor);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

export function isTrustedGenerationStreamOrigin(
  request: Request,
  env: Pick<Env, "WEB_ORIGIN">,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const configuredOrigin = env.WEB_ORIGIN?.replace(/\/+$/, "");
  if (configuredOrigin) return origin === configuredOrigin;

  return isLocalOrigin(origin) && isLocalOrigin(new URL(request.url).origin);
}

export async function streamGenerationEvents(input: {
  stream: SSEStreamingApi;
  jobs: JobsRepository;
  userId: string;
  initialState: GenerationStreamState;
  initialSequence: number;
  env: Env;
}): Promise<void> {
  const settings = getGenerationStreamSettings(input.env);
  const startedAt = Date.now();
  let generation = input.initialState.generation;
  let sequence = input.initialSequence;
  let lastHeartbeatAt = 0;
  let terminalObservedAt: number | null = null;

  await writeMessage(input.stream, {
    type: "snapshot",
    generation,
    latestSequence: input.initialState.latestSequence,
  });

  while (!input.stream.aborted && Date.now() - startedAt < settings.maxDurationMs) {
    const events = await input.jobs.listEventsAfter(generation.id, sequence, EVENT_BATCH_SIZE);
    for (const event of events) {
      sequence = event.sequence;
      const logEvent = toGenerationLogEvent(event);
      if (logEvent) await writeMessage(input.stream, { type: "event", event: logEvent }, event.sequence);
    }

    const currentState = await input.jobs.getStreamStateForProject({
      userId: input.userId,
      projectId: generation.projectId,
      jobId: generation.id,
    });

    if (!currentState) return;

    const currentGeneration = currentState.generation;
    const latestSequence = currentState.latestSequence;
    if (hasGenerationChanged(generation, currentGeneration)) {
      generation = currentGeneration;
      await writeMessage(input.stream, {
        type: "generation",
        generation,
        latestSequence,
      });
    }

    const now = Date.now();
    if (isTerminalGeneration(generation) && sequence >= latestSequence) {
      terminalObservedAt ??= now;
      if (now - terminalObservedAt >= settings.terminalGraceMs) {
        await writeMessage(input.stream, {
          type: "complete",
          generation,
          latestSequence,
        });
        return;
      }
    } else {
      terminalObservedAt = null;
    }

    if (now - lastHeartbeatAt >= settings.heartbeatMs) {
      await writeMessage(input.stream, { type: "heartbeat", latestSequence });
      lastHeartbeatAt = now;
    }

    if (events.length === EVENT_BATCH_SIZE) continue;
    await input.stream.sleep(settings.pollIntervalMs);
  }
}

function hasGenerationChanged(previous: GenerationJobDto, current: GenerationJobDto): boolean {
  return previous.updatedAt !== current.updatedAt
    || previous.status !== current.status
    || previous.docsVersionId !== current.docsVersionId
    || previous.errorMessage !== current.errorMessage;
}

function isTerminalGeneration(generation: GenerationJobDto): boolean {
  return generation.status === "succeeded"
    || generation.status === "failed"
    || generation.status === "cancelled";
}

async function writeMessage(
  stream: SSEStreamingApi,
  message: GenerationStreamMessage,
  sequence?: number,
): Promise<void> {
  await stream.writeSSE({
    event: message.type,
    data: JSON.stringify(message),
    id: sequence === undefined ? undefined : String(sequence),
    retry: 2_000,
  });
}

function getGenerationStreamSettings(env: Env): GenerationStreamSettings {
  return {
    pollIntervalMs: parseDuration(env.GENERATION_STREAM_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 10, 10_000),
    heartbeatMs: parseDuration(env.GENERATION_STREAM_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 1_000, 60_000),
    terminalGraceMs: parseDuration(env.GENERATION_STREAM_TERMINAL_GRACE_MS, DEFAULT_TERMINAL_GRACE_MS, 0, 10_000),
    maxDurationMs: parseDuration(env.GENERATION_STREAM_MAX_DURATION_MS, DEFAULT_MAX_DURATION_MS, 100, 30 * 60_000),
  };
}

function parseDuration(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}
