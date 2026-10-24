import {
  containerGenerationStageStreamRecordSchema,
  type ContainerGenerationEvent,
  type ContainerGenerationStageRequest,
  type ContainerGenerationStageResult,
  type ContainerGenerateHeartbeatRecord,
  type GenerationRepairDiagnostic,
  type GenerationUsageRecord,
  type StagedRuntimePage,
} from "@doxahq/contracts";
import type { AgentContainerBinding } from "@doxahq/generation";

export interface GenerationStageClientDeps {
  agentContainerBinding?: AgentContainerBinding;
  agentContainerUrl?: string;
  idleTimeoutMs: number;
  fetch?: typeof fetch;
}

interface StageStreamCallbacks {
  onHeartbeat?: (heartbeat: ContainerGenerateHeartbeatRecord) => Promise<void> | void;
  onEvent?: (event: ContainerGenerationEvent) => Promise<void> | void;
  onUsage?: (record: GenerationUsageRecord) => Promise<void> | void;
  onDiagnostic?: (
    diagnostic: GenerationRepairDiagnostic,
  ) => Promise<void> | void;
  onPageCheckpoint?: (
    page: StagedRuntimePage,
  ) => Promise<void> | void;
  onActivity?: () => void;
}

export class GenerationStageRequestError extends Error {
  readonly retryable: boolean;
  readonly code: string;

  constructor(message: string, retryable: boolean, code = "generation_stage_failed") {
    super(message);
    this.name = "GenerationStageRequestError";
    this.retryable = retryable;
    this.code = code;
  }
}

export async function callGenerationStage(
  input: ContainerGenerationStageRequest,
  deps: GenerationStageClientDeps,
  callbacks: StageStreamCallbacks = {},
): Promise<ContainerGenerationStageResult> {
  const controller = new AbortController();
  const idleDeadline = createIdleDeadline(deps.idleTimeoutMs, controller);
  const pathname = input.stage === "analysis"
    ? "/stages/analyze/stream"
    : `/stages/${input.stage}/stream`;
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: controller.signal,
  };

  try {
    const operation = (async () => {
      const response = await sendStageRequest(pathname, requestInit, deps);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        const message = typeof payload?.error === "string"
          ? payload.error
          : `Generation stage request failed (${response.status}).`;
        throw new Error(message);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/x-ndjson")) {
        throw new Error("Generation stage returned a non-streaming response.");
      }
      const result = await readGenerationStageStream(response, {
        ...callbacks,
        onActivity: () => {
          idleDeadline.recordActivity();
          callbacks.onActivity?.();
        },
      });
      if (result.stage !== input.stage) {
        throw new Error(`Generation stage returned ${result.stage} for a ${input.stage} request.`);
      }
      return result;
    })();
    return await Promise.race([operation, idleDeadline.promise]);
  } finally {
    idleDeadline.clear();
    if (!controller.signal.aborted) controller.abort();
  }
}

export async function readGenerationStageStream(
  response: Response,
  callbacks: StageStreamCallbacks = {},
): Promise<ContainerGenerationStageResult> {
  if (!response.body) throw new Error("Generation stage stream response did not include a body.");

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let result: ContainerGenerationStageResult | null = null;

  const consumeLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new Error("Generation stage stream returned malformed JSON.");
    }
    const parsed = containerGenerationStageStreamRecordSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Generation stage stream returned an invalid record.");
    callbacks.onActivity?.();
    if (parsed.data.kind === "heartbeat") {
      await callbacks.onHeartbeat?.(parsed.data);
    } else if (parsed.data.kind === "event") {
      await callbacks.onEvent?.(parsed.data.event);
    } else if (parsed.data.kind === "usage") {
      const record = parsed.data.record;
      await runBestEffortObservation(
        "usage",
        record.jobId,
        () => callbacks.onUsage?.(record),
      );
    } else if (parsed.data.kind === "diagnostic") {
      const diagnostic = parsed.data.diagnostic;
      await runBestEffortObservation(
        "diagnostic",
        diagnostic.jobId,
        () => callbacks.onDiagnostic?.(diagnostic),
      );
    } else if (parsed.data.kind === "page_checkpoint") {
      await callbacks.onPageCheckpoint?.(parsed.data.page);
    } else if (parsed.data.kind === "error") {
      throw new GenerationStageRequestError(
        parsed.data.error.message,
        parsed.data.error.retryable,
        parsed.data.error.code,
      );
    } else {
      result = parsed.data.result;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) await consumeLine(line);
    }
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) await consumeLine(buffer);
      break;
    }
  }

  if (!result) throw new Error("Generation stage stream ended without a result.");
  return result;
}

async function runBestEffortObservation(
  kind: "usage" | "diagnostic",
  jobId: string,
  observe: () => Promise<void> | void | undefined,
): Promise<void> {
  try {
    await observe();
  } catch (error) {
    console.error(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_observability_persistence_failed",
      kind,
      jobId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function sendStageRequest(
  pathname: string,
  requestInit: RequestInit,
  deps: GenerationStageClientDeps,
): Promise<Response> {
  const baseUrl = deps.agentContainerUrl?.replace(/\/+$/, "");
  if (deps.agentContainerBinding) {
    try {
      const response = await deps.agentContainerBinding.fetch(
        new Request(`https://agent-container.internal${pathname}`, requestInit),
      );
      if (!baseUrl || !isRetryableStatus(response.status)) return response;
    } catch (error) {
      if (!baseUrl) throw error;
    }
  }
  if (!baseUrl) throw new Error("Agent container binding is not configured.");
  return (deps.fetch ?? fetch)(`${baseUrl}${pathname}`, requestInit);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function createIdleDeadline(idleTimeoutMs: number, controller: AbortController) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const recordActivity = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      const error = new Error(`Generation stage stopped responding for ${Math.ceil(idleTimeoutMs / 1000)} seconds.`);
      controller.abort(error);
      rejectDeadline?.(error);
    }, idleTimeoutMs);
  };
  recordActivity();
  return {
    promise,
    recordActivity,
    clear() {
      if (timeout) clearTimeout(timeout);
    },
  };
}
