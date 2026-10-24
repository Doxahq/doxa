import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { startSupervisor, type SupervisorOptions } from "../src/supervisor";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function start(fixture: string, overrides: Partial<SupervisorOptions> = {}): Promise<string> {
  const server = startSupervisor({
    job: "test-job",
    port: 0,
    entry: join(fixtures, fixture),
    readDirectory: fixtures,
    heapMb: 64,
    timeoutMs: 10_000,
    maxRequestBytes: 1_000,
    maxOutputBytes: 64 * 1024,
    ...overrides,
  });
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("job supervisor", () => {
  test("runs the job for POST /run and returns its outcome", async () => {
    const base = await start("echo-job.mjs");

    const response = await fetch(`${base}/run`, { method: "POST", body: "hello" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, output: "hello" });
  });

  test("has no other route", async () => {
    const base = await start("echo-job.mjs");

    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/run`)).status).toBe(405);
  });

  test("refuses an input over the limit before it starts the job", async () => {
    const base = await start("echo-job.mjs");

    const response = await fetch(`${base}/run`, { method: "POST", body: "x".repeat(1_001) });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "input_too_large" } });
  });

  test("runs one job call at a time", async () => {
    const base = await start("hang-job.mjs", { timeoutMs: 1_000 });

    const first = fetch(`${base}/run`, { method: "POST", body: "a" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await fetch(`${base}/run`, { method: "POST", body: "b" });

    expect(second.status).toBe(429);
    await expect((await first).json()).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});
