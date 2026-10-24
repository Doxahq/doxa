import type {
  AddJobEventInput,
  ContainerGenerationEvent,
} from "@doxahq/contracts";
import {
  sanitizeErrorMessage,
  sanitizeEvent,
} from "@doxahq/generation";

export interface ForwardGenerationStageEventInput {
  jobId: string;
  stage: string;
  event: ContainerGenerationEvent;
  secrets: string[];
  persist: (event: AddJobEventInput) => Promise<unknown>;
  log?: (record: string) => void;
}

export interface ForwardGenerationStageFailureInput {
  jobId: string;
  stage: string;
  errorMessage: string;
  retryable: boolean;
  code: string;
  secrets: string[];
  persist: (event: AddJobEventInput) => Promise<unknown>;
  log?: (record: string) => void;
}

export async function forwardGenerationStageEvent(
  input: ForwardGenerationStageEventInput,
): Promise<void> {
  const sanitized = sanitizeEvent(input.event, input.secrets);
  try {
    await input.persist({
      type: sanitized.type,
      message: sanitized.message,
      source: sanitized.source ?? "container",
      data: sanitized.data,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(
      error instanceof Error
        ? error.message
        : "Generation stage event delivery failed.",
      input.secrets,
    );
    (input.log ?? console.error)(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_stage_event_delivery_failed",
      jobId: input.jobId,
      stage: input.stage,
      sourceEventType: sanitized.type,
      error: message,
    }));
  }
}

export async function forwardGenerationStageFailure(
  input: ForwardGenerationStageFailureInput,
): Promise<void> {
  const message = sanitizeErrorMessage(input.errorMessage, input.secrets);
  const stageLabel = `${input.stage.charAt(0).toUpperCase()}${input.stage.slice(1)}`;
  try {
    await input.persist({
      // A retryable attempt is not a failure of the run. The dashboard styles
      // every "*_failed" event as an error, so only a final attempt gets that
      // suffix.
      type: input.retryable
        ? "generation_stage_attempt_retrying"
        : "generation_stage_attempt_failed",
      message: input.retryable
        ? `${stageLabel} stage attempt failed and will retry: ${message}`
        : `${stageLabel} stage attempt failed: ${message}`,
      source: "worker",
      data: {
        stage: input.stage,
        retryable: input.retryable,
        code: input.code,
      },
    });
  } catch (error) {
    const persistenceMessage = sanitizeErrorMessage(
      error instanceof Error
        ? error.message
        : "Generation stage failure event delivery failed.",
      input.secrets,
    );
    (input.log ?? console.error)(JSON.stringify({
      service: "doxa-agent-worker",
      eventType: "generation_stage_failure_event_delivery_failed",
      jobId: input.jobId,
      stage: input.stage,
      error: persistenceMessage,
    }));
  }
}
