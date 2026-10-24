import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireSharedMdxValidatorPool,
  createMdxValidatorPool,
  releaseSharedMdxValidatorPool,
  type MdxValidatorChildProcess,
  type MdxValidatorSpawn,
} from "../src/utils/mdx-validator-pool";
import {
  compileMdx,
  type MdxCompileResult,
} from "../src/utils/mdx-compile";

interface ValidatorRequest {
  id: string;
  source: string;
  process: FakeValidatorProcess;
}

class FakeValidatorProcess
  extends EventEmitter
  implements MdxValidatorChildProcess
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private input = "";

  constructor(
    private readonly requests: ValidatorRequest[],
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.input += chunk;
      this.consumeLines();
    });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  exit(code = 1): void {
    this.emit("exit", code, null);
  }

  respond(id: string, result: MdxCompileResult): void {
    this.stdout.write(`${JSON.stringify({ id, ...result })}\n`);
  }

  writeMalformedOutput(): void {
    this.stdout.write("not-json\n");
  }

  private consumeLines(): void {
    let newline = this.input.indexOf("\n");
    while (newline >= 0) {
      const line = this.input.slice(0, newline);
      this.input = this.input.slice(newline + 1);
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === "object" &&
        "id" in parsed &&
        typeof parsed.id === "string" &&
        "source" in parsed &&
        typeof parsed.source === "string"
      ) {
        this.requests.push({
          id: parsed.id,
          source: parsed.source,
          process: this,
        });
      }
      newline = this.input.indexOf("\n");
    }
  }
}

const pools: Array<ReturnType<typeof createMdxValidatorPool>> = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

function createHarness(options: {
  size?: number;
  requestTimeoutMs?: number;
} = {}) {
  const requests: ValidatorRequest[] = [];
  const processes: FakeValidatorProcess[] = [];
  const spawn: MdxValidatorSpawn = () => {
    const process = new FakeValidatorProcess(requests);
    processes.push(process);
    return process;
  };
  const pool = createMdxValidatorPool({
    size: options.size ?? 2,
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    scriptPath: "/synthetic/mdx-validator-server.mjs",
    spawn,
  });
  pools.push(pool);
  return { pool, processes, requests };
}

function validResult(): MdxCompileResult {
  return { ok: true, errors: [] };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MDX validator pool", () => {
  test("prefers an explicit pool size over the environment", async () => {
    vi.stubEnv("DOXA_MDX_VALIDATOR_POOL_SIZE", "4");
    const { pool, requests } = createHarness({ size: 2 });

    const pending = [
      pool.compile("# First"),
      pool.compile("# Second"),
      pool.compile("# Third"),
    ];
    await flushMicrotasks();
    const observedSpawnCount = pool.spawnCount;
    for (const request of requests.splice(0)) {
      request.process.respond(request.id, validResult());
    }
    await flushMicrotasks();
    for (const request of requests.splice(0)) {
      request.process.respond(request.id, validResult());
    }
    await Promise.all(pending);

    expect(observedSpawnCount).toBe(2);
  });

  test("reuses at most the configured number of workers", async () => {
    const { pool, requests } = createHarness({ size: 2 });

    for (let index = 0; index < 20; index += 1) {
      const pending = pool.compile(`# Page ${index}`);
      await flushMicrotasks();
      const request = requests.shift();
      expect(request).toBeDefined();
      request?.process.respond(request.id, validResult());
      await expect(pending).resolves.toEqual(validResult());
    }

    expect(pool.spawnCount).toBeLessThanOrEqual(2);
  });

  test("correlates concurrent responses by id when workers finish out of order", async () => {
    const { pool, requests } = createHarness({ size: 2 });
    const first = pool.compile("# First");
    const second = pool.compile("# Second");
    await flushMicrotasks();

    expect(requests).toHaveLength(2);
    const firstRequest = requests.find((request) => request.source === "# First");
    const secondRequest = requests.find((request) => request.source === "# Second");
    expect(firstRequest).toBeDefined();
    expect(secondRequest).toBeDefined();

    secondRequest?.process.respond(secondRequest.id, {
      ok: false,
      errors: [{
        rule: "second-error",
        severity: "hard",
        line: 2,
        col: 3,
        message: "Second failed",
        snippet: "# Second",
      }],
    });
    firstRequest?.process.respond(firstRequest.id, validResult());

    await expect(first).resolves.toEqual(validResult());
    await expect(second).resolves.toMatchObject({
      ok: false,
      errors: [{ rule: "second-error" }],
    });
  });

  test("fails closed when a worker exits and respawns for the next request", async () => {
    const { pool, processes, requests } = createHarness({ size: 1 });
    const first = pool.compile("# First");
    await flushMicrotasks();
    processes[0]?.exit();

    await expect(first).resolves.toMatchObject({
      ok: false,
      errors: [{ rule: "validator-crashed" }],
    });

    const second = pool.compile("# Second");
    await flushMicrotasks();
    const request = requests.find((candidate) => candidate.source === "# Second");
    request?.process.respond(request.id, validResult());

    await expect(second).resolves.toEqual(validResult());
    expect(pool.spawnCount).toBe(2);
  });

  test("resolves the whole queue when replacement worker dispatch fails", async () => {
    const requests: ValidatorRequest[] = [];
    const processes: FakeValidatorProcess[] = [];
    let spawnAttempts = 0;
    const pool = createMdxValidatorPool({
      size: 1,
      scriptPath: "/synthetic/mdx-validator-server.mjs",
      spawn: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 2) {
          throw new Error("process limit reached");
        }
        const process = new FakeValidatorProcess(requests);
        processes.push(process);
        return process;
      },
    });

    const pending = [
      pool.compile("# First"),
      pool.compile("# Second"),
      pool.compile("# Third"),
    ];
    await flushMicrotasks();
    expect(requests).toHaveLength(1);

    expect(() => processes[0]?.exit()).not.toThrow();
    const results = await Promise.all(pending);

    expect(results).toHaveLength(3);
    expect(results.every(
      (result) =>
        !result.ok
        && result.errors[0]?.rule === "validator-crashed",
    )).toBe(true);
  });

  test("kills an unresponsive worker and respawns after the request timeout", async () => {
    vi.useFakeTimers();
    const { pool, processes, requests } = createHarness({
      size: 1,
      requestTimeoutMs: 25,
    });
    const timedOut = pool.compile("# Never answers");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toMatchObject({
      ok: false,
      errors: [{ rule: "validator-crashed" }],
    });
    expect(processes[0]?.killed).toBe(true);

    const next = pool.compile("# Next");
    await flushMicrotasks();
    const request = requests.find((candidate) => candidate.source === "# Next");
    request?.process.respond(request.id, validResult());
    await expect(next).resolves.toEqual(validResult());
    expect(pool.spawnCount).toBe(2);
  });

  test("does not retry a timed-out pooled request through the one-shot validator", async () => {
    vi.useFakeTimers();
    const { pool } = createHarness({
      size: 1,
      requestTimeoutMs: 25,
    });
    const compileOneShot = vi.fn(async () => validResult());

    const pending = compileMdx("# Never answers", {
      runtime: { pool, compileOneShot },
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      errors: [{ rule: "validator-crashed" }],
    });
    expect(pool.isAvailable()).toBe(true);
    expect(compileOneShot).not.toHaveBeenCalled();
  });

  test("falls back to one-shot validation when the pool cannot start", async () => {
    const pool = createMdxValidatorPool({
      size: 1,
      scriptPath: "/synthetic/mdx-validator-server.mjs",
      spawn: () => {
        throw new Error("process limit reached");
      },
    });
    pools.push(pool);
    const compileOneShot = vi.fn(async () => validResult());

    await expect(compileMdx("# Startup fallback", {
      runtime: { pool, compileOneShot },
    })).resolves.toEqual(validResult());

    expect(pool.isAvailable()).toBe(false);
    expect(compileOneShot).toHaveBeenCalledTimes(1);
  });

  test("fails closed on malformed worker output", async () => {
    const { pool, processes } = createHarness({ size: 1 });
    const pending = pool.compile("# Invalid response");
    await flushMicrotasks();
    processes[0]?.writeMalformedOutput();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      errors: [{ rule: "validator-crashed" }],
    });
  });

  test("disposes workers and starts fresh on a subsequent compile", async () => {
    const { pool, processes, requests } = createHarness({ size: 1 });
    const first = pool.compile("# First");
    await flushMicrotasks();
    const firstRequest = requests.shift();
    firstRequest?.process.respond(firstRequest.id, validResult());
    await first;

    await pool.dispose();
    expect(processes[0]?.killed).toBe(true);

    const second = pool.compile("# Second");
    await flushMicrotasks();
    const secondRequest = requests.shift();
    secondRequest?.process.respond(secondRequest.id, validResult());
    await expect(second).resolves.toEqual(validResult());
    expect(pool.spawnCount).toBe(2);
  });

  test("keeps shared workers alive until every overlapping owner releases them", async () => {
    const firstOwner = acquireSharedMdxValidatorPool();
    const secondOwner = acquireSharedMdxValidatorPool();
    expect(secondOwner).toBe(firstOwner);

    await firstOwner.warm();
    const spawnCount = firstOwner.spawnCount;
    expect(firstOwner.activeWorkerCount).toBeGreaterThan(0);

    await releaseSharedMdxValidatorPool();
    await expect(secondOwner.compile("# Still owned")).resolves.toEqual(validResult());
    expect(secondOwner.spawnCount).toBe(spawnCount);
    expect(secondOwner.activeWorkerCount).toBeGreaterThan(0);

    await releaseSharedMdxValidatorPool();
    expect(secondOwner.activeWorkerCount).toBe(0);
  });
});
