import type { WriterDiagnosticCallback } from "@doxahq/agent";
import type { ContainerGenerateRequest, ContainerGenerationEvent } from "@doxahq/contracts";

export interface ContainerLogger {
  event(event: ContainerGenerationEvent): void;
  error(message: string, data?: Record<string, unknown>): void;
}

type RequestCredentials = Pick<ContainerGenerateRequest, "installationAccessToken" | "modelApiKey" | "modelAuthToken">;

/** Every credential a request carries, so that no log, event or error shows one. */
export function requestSecrets(input: RequestCredentials): string[] {
  return [input.installationAccessToken, input.modelApiKey, input.modelAuthToken]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

/**
 * Environment variables that hold public runtime settings. Every other value
 * counts as a secret: a secret can have any name, and no page needs a value
 * from the container environment.
 */
const PUBLIC_ENVIRONMENT_NAME =
  /^(?:PATH|HOME|PWD|OLDPWD|HOSTNAME|SHLVL|SHELL|USER|TERM|LANG|TZ|_|LC_\w+|NODE_\w+|npm_\w+|PNPM_\w+|COREPACK_\w+|YARN_VERSION|GIT_SSL_CAINFO|DOXA_WORKSPACE_ROOT|DOXA_PERFORMANCE_LOG_DIR)$/;
/** Shorter values are flags or IDs, and would match ordinary page text. */
const MIN_ENVIRONMENT_SECRET_LENGTH = 16;

/** Values of the environment variables of this process that can be secrets. */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) =>
      !PUBLIC_ENVIRONMENT_NAME.test(name) && typeof value === "string" && value.length >= MIN_ENVIRONMENT_SECRET_LENGTH
    )
    .map(([, value]) => value as string);
}

/**
 * Every value that no output of a request may contain: its credentials and
 * the secret environment values. Pages, events, results and logs mask them.
 */
export function outputSecrets(input: RequestCredentials, env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...requestSecrets(input), ...environmentSecrets(env)])];
}

/**
 * Credentials of the requests that run now. Process output redaction masks
 * them, because library code (a model provider adapter, for example) can log a
 * raw error that repeats a credential.
 */
const activeSecrets = new Map<string, number>();

/** Masks the credentials in all process output until the returned release runs. */
export function registerActiveSecrets(secrets: readonly string[]): () => void {
  for (const secret of secrets) activeSecrets.set(secret, (activeSecrets.get(secret) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const secret of secrets) {
      const count = (activeSecrets.get(secret) ?? 0) - 1;
      if (count > 0) activeSecrets.set(secret, count);
      else activeSecrets.delete(secret);
    }
  };
}

let outputRedactionInstalled = false;

/**
 * Masks active credentials in everything the process writes to stdout and
 * stderr: console calls, library loggers and uncaught error reports. Install
 * it once, before the server starts.
 */
export function installOutputRedaction(): void {
  if (outputRedactionInstalled) return;
  outputRedactionInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) =>
      write(redactOutputChunk(chunk), ...rest)) as typeof stream.write;
  }
}

/** One stdout or stderr chunk with every active credential masked. */
export function redactOutputChunk(chunk: unknown): unknown {
  if (activeSecrets.size === 0) return chunk;
  const secrets = [...activeSecrets.keys()];
  if (typeof chunk === "string") return sanitizeText(chunk, secrets);
  if (chunk instanceof Uint8Array) {
    const text = Buffer.from(chunk).toString("utf8");
    const redacted = sanitizeText(text, secrets);
    return redacted === text ? chunk : Buffer.from(redacted, "utf8");
  }
  return chunk;
}

export function createContainerLogger(input: ContainerGenerateRequest, startedAt: number): ContainerLogger {
  const secrets = outputSecrets(input);

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

export function createWriterDiagnosticLogger(input: RequestCredentials & { jobId: string }): WriterDiagnosticCallback {
  const secrets = outputSecrets(input);

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
