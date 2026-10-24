import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawn as spawnProcess } from "node:child_process";
import type { MdxCompileError, MdxCompileResult } from "./mdx-compile";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_POOL_SIZE = 4;
const SERVER_RELATIVE_PATH = join("runtime", "mdx-validator-server.mjs");

export interface MdxValidatorChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(
    event: "error",
    listener: (error: Error) => void,
  ): this;
  on(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type MdxValidatorSpawn = (
  scriptPath: string,
) => MdxValidatorChildProcess;

export interface MdxValidatorPoolOptions {
  size?: number;
  requestTimeoutMs?: number;
  scriptPath?: string;
  spawn?: MdxValidatorSpawn;
}

export interface MdxValidatorPool {
  compile(source: string): Promise<MdxCompileResult>;
  warm(): Promise<void>;
  dispose(): Promise<void>;
  isAvailable(): boolean;
  readonly spawnCount: number;
  readonly activeWorkerCount: number;
}

interface PendingRequest {
  id: string;
  source: string;
  resolve: (result: MdxCompileResult) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface ValidatorWorker {
  process: MdxValidatorChildProcess;
  outputBuffer: string;
  active: boolean;
  request?: PendingRequest;
}

interface WorkerResponse {
  id: string;
  result: MdxCompileResult;
}

export function createMdxValidatorPool(
  options: MdxValidatorPoolOptions = {},
): MdxValidatorPool {
  const size = resolvePoolSize(options.size);
  const requestTimeoutMs = resolveRequestTimeout(options.requestTimeoutMs);
  const scriptPath = options.scriptPath ?? resolveMdxValidatorServerPath();
  const spawn = options.spawn ?? spawnValidatorProcess;
  const workers: ValidatorWorker[] = [];
  const queue: PendingRequest[] = [];
  const idleWaiters = new Set<() => void>();
  let totalSpawnCount = 0;
  let available = true;
  let warmPromise: Promise<void> | undefined;
  let disposalPromise: Promise<void> | undefined;

  const dispatch = (): void => {
    while (queue.length > 0) {
      let worker = workers.find(
        (candidate) => candidate.active && !candidate.request,
      );
      if (!worker && workers.length < size) {
        try {
          worker = startWorker();
        } catch (error) {
          failQueuedRequests(
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      }
      if (!worker) break;

      const request = queue.shift();
      if (!request) break;
      worker.request = request;
      request.timeout = setTimeout(() => {
        failWorker(
          worker,
          `MDX validator timed out after ${requestTimeoutMs}ms`,
          true,
        );
      }, requestTimeoutMs);

      try {
        worker.process.stdin.write(
          `${JSON.stringify({ id: request.id, source: request.source })}\n`,
          (error) => {
            if (error) {
              failWorker(
                worker,
                `Failed to write to MDX validator: ${error.message}`,
                true,
              );
            }
          },
        );
      } catch (error) {
        failWorker(
          worker,
          `Failed to write to MDX validator: ${
            error instanceof Error ? error.message : String(error)
          }`,
          true,
        );
      }
    }
    notifyIdle();
  };

  const startWorker = (): ValidatorWorker => {
    if (!scriptPath) {
      available = false;
      throw new Error(
        `Could not locate ${SERVER_RELATIVE_PATH} relative to the @doxahq/agent runtime.`,
      );
    }
    let process: MdxValidatorChildProcess;
    try {
      process = spawn(scriptPath);
    } catch (error) {
      available = false;
      throw error;
    }
    const worker: ValidatorWorker = {
      process,
      outputBuffer: "",
      active: true,
    };
    workers.push(worker);
    totalSpawnCount += 1;

    worker.process.stdout.setEncoding("utf8");
    worker.process.stdout.on("data", (chunk: string) => {
      worker.outputBuffer += chunk;
      consumeWorkerOutput(worker);
    });
    worker.process.stderr.resume();
    worker.process.on("error", (error) => {
      failWorker(
        worker,
        `MDX validator worker error: ${error.message}`,
        false,
      );
    });
    worker.process.on("exit", (code, signal) => {
      failWorker(
        worker,
        `MDX validator worker exited (code ${code}, signal ${signal ?? "none"})`,
        false,
      );
    });
    return worker;
  };

  const consumeWorkerOutput = (worker: ValidatorWorker): void => {
    let newlineIndex = worker.outputBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = worker.outputBuffer.slice(0, newlineIndex).trim();
      worker.outputBuffer = worker.outputBuffer.slice(newlineIndex + 1);
      if (line) {
        const response = parseWorkerResponse(line);
        if (!response || response.id !== worker.request?.id) {
          failWorker(
            worker,
            "MDX validator returned malformed or uncorrelated output",
            true,
          );
          return;
        }
        completeRequest(worker, response.result);
      }
      newlineIndex = worker.outputBuffer.indexOf("\n");
    }
  };

  const completeRequest = (
    worker: ValidatorWorker,
    result: MdxCompileResult,
  ): void => {
    const request = worker.request;
    if (!request) return;
    if (request.timeout) clearTimeout(request.timeout);
    worker.request = undefined;
    request.resolve(result);
    dispatch();
  };

  const failWorker = (
    worker: ValidatorWorker,
    message: string,
    kill: boolean,
  ): void => {
    if (!worker.active) return;
    worker.active = false;
    const workerIndex = workers.indexOf(worker);
    if (workerIndex >= 0) workers.splice(workerIndex, 1);
    const request = worker.request;
    worker.request = undefined;
    if (request?.timeout) clearTimeout(request.timeout);
    request?.resolve(validatorCrashed(message));
    if (kill) worker.process.kill("SIGTERM");
    dispatch();
  };

  const notifyIdle = (): void => {
    if (queue.length > 0 || workers.some((worker) => worker.request)) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const failQueuedRequests = (message: string): void => {
    for (const request of queue.splice(0)) {
      if (request.timeout) clearTimeout(request.timeout);
      request.resolve(validatorCrashed(message));
    }
    notifyIdle();
  };

  const waitUntilIdle = async (): Promise<void> => {
    if (queue.length === 0 && workers.every((worker) => !worker.request)) {
      return;
    }
    await new Promise<void>((resolve) => {
      idleWaiters.add(resolve);
    });
  };

  const pool: MdxValidatorPool = {
    compile: async (source) => {
      return new Promise<MdxCompileResult>((resolve) => {
        const request: PendingRequest = {
          id: randomUUID(),
          source,
          resolve,
        };
        queue.push(request);
        try {
          dispatch();
        } catch (error) {
          failQueuedRequests(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    warm: async () => {
      warmPromise ??= Promise.all(
        Array.from(
          { length: size },
          (_, index) => pool.compile(`# MDX validator readiness ${index + 1}\n`),
        ),
      ).then((results) => {
        const failure = results.find((result) => !result.ok);
        if (!failure) return;
        throw new Error(
          failure.errors.map((error) => error.message).join("; ") ||
            "MDX validator pool failed to start.",
        );
      });
      await warmPromise;
    },
    dispose: async () => {
      disposalPromise ??= (async () => {
        await waitUntilIdle();
        for (const worker of workers.splice(0)) {
          worker.active = false;
          worker.process.kill("SIGTERM");
        }
        warmPromise = undefined;
        available = true;
      })().finally(() => {
        disposalPromise = undefined;
      });
      await disposalPromise;
    },
    get spawnCount() {
      return totalSpawnCount;
    },
    get activeWorkerCount() {
      return workers.length;
    },
    isAvailable: () => available,
  };

  return pool;
}

let sharedPool: MdxValidatorPool | undefined;
let beforeExitRegistered = false;
let sharedPoolReferences = 0;

export function getSharedMdxValidatorPool(): MdxValidatorPool {
  sharedPool ??= createMdxValidatorPool();
  if (!beforeExitRegistered) {
    beforeExitRegistered = true;
    process.once("beforeExit", () => {
      void sharedPool?.dispose();
    });
  }
  return sharedPool;
}

export function acquireSharedMdxValidatorPool(): MdxValidatorPool {
  sharedPoolReferences += 1;
  return getSharedMdxValidatorPool();
}

export async function releaseSharedMdxValidatorPool(): Promise<void> {
  if (sharedPoolReferences === 0) return;
  sharedPoolReferences -= 1;
  if (sharedPoolReferences === 0) {
    await sharedPool?.dispose();
  }
}

export async function disposeMdxValidatorPool(): Promise<void> {
  await sharedPool?.dispose();
}

export function resolveMdxValidatorServerPath(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(directory, SERVER_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function spawnValidatorProcess(
  scriptPath: string,
): MdxValidatorChildProcess {
  return spawnProcess(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function resolvePoolSize(configuredSize: number | undefined): number {
  const environmentSize = parsePositiveInteger(
    process.env.DOXA_MDX_VALIDATOR_POOL_SIZE,
  );
  const requested = configuredSize ??
    environmentSize ??
    Math.max(1, cpus().length - 1);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("MDX validator pool size must be a positive integer.");
  }
  return Math.min(MAX_POOL_SIZE, requested);
}

function resolveRequestTimeout(configuredTimeout: number | undefined): number {
  const timeout = configuredTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("MDX validator request timeout must be a positive integer.");
  }
  return timeout;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseWorkerResponse(line: string): WorkerResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "string") return undefined;
  if (record.ok === true) {
    return {
      id: record.id,
      result: { ok: true, errors: [] },
    };
  }
  if (record.ok !== false || !Array.isArray(record.errors)) return undefined;
  const errors: MdxCompileError[] = [];
  for (const value of record.errors) {
    const error = parseMdxCompileError(value);
    if (!error) return undefined;
    errors.push(error);
  }
  return {
    id: record.id,
    result: { ok: false, errors },
  };
}

function parseMdxCompileError(value: unknown): MdxCompileError | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.rule !== "string" ||
    typeof record.line !== "number" ||
    typeof record.col !== "number" ||
    typeof record.message !== "string"
  ) {
    return undefined;
  }
  return {
    rule: record.rule,
    severity: "hard",
    line: record.line,
    col: record.col,
    message: record.message,
    snippet: typeof record.snippet === "string" ? record.snippet : "",
  };
}

function validatorCrashed(message: string): MdxCompileResult {
  return {
    ok: false,
    errors: [{
      rule: "validator-crashed",
      severity: "hard",
      line: 0,
      col: 0,
      message,
      snippet: "",
    }],
  };
}
