import type { WriterDiagnosticCallback } from "@doxahq/agent";
import type { ContainerGenerateRequest, ContainerGenerationEvent } from "@doxahq/contracts";

export interface ContainerLogger {
  event(event: ContainerGenerationEvent): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createContainerLogger(input: ContainerGenerateRequest, startedAt: number): ContainerLogger {
  const secrets = [input.installationAccessToken, input.modelApiKey].filter(Boolean);

  return {
    event(event) {
      console.log(JSON.stringify({
        service: "doxa-agent-container",
        jobId: input.jobId,
        source: event.source ?? "container",
        sequence: event.sequence ?? null,
        eventType: event.type,
        message: sanitizeValue(event.message, secrets),
        elapsedMs: event.elapsedMs ?? Date.now() - startedAt,
        data: sanitizeValue(event.data ?? {}, secrets),
      }));
    },
    error(message, data) {
      console.error(JSON.stringify({
        service: "doxa-agent-container",
        jobId: input.jobId,
        eventType: "failed",
        message: sanitizeValue(message, secrets),
        elapsedMs: Date.now() - startedAt,
        data: sanitizeValue(data ?? {}, secrets),
      }));
    },
  };
}

export function createWriterDiagnosticLogger(input: {
  jobId: string;
  installationAccessToken: string;
  modelApiKey: string;
}): WriterDiagnosticCallback {
  const secrets = [input.installationAccessToken, input.modelApiKey].filter(Boolean);

  return (event) => {
    console.log(JSON.stringify({
      service: "doxa-agent-writer",
      jobId: input.jobId,
      ...sanitizeValue(event, secrets),
    }));
  };
}

export function sanitizeValue<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    return sanitizeText(value, secrets) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, secrets)]),
    ) as T;
  }

  return value;
}

export function sanitizeText(value: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => {
    if (!secret) return current;
    return [secret, encodeURIComponent(secret)].reduce(
      (next, candidate) => next.split(candidate).join("[redacted]"),
      current,
    );
  }, value);
}
