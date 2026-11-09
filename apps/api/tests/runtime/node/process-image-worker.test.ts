import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProcessImageWorker } from "../../../src/runtime/node/image-processing/process-image-worker";

const folder = mkdtempSync(path.join(tmpdir(), "image-compressor-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function childScript(name: string, body: string): string {
  const file = path.join(folder, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

const reply = (json: string) =>
  `process.once("message", (job) => process.send(${json}, undefined, undefined, () => process.exit(0)));`;

const input = {
  bytes: Uint8Array.from([1, 2, 3, 4]),
  contentType: "image/png",
  profile: "docs_image",
} as const;

describe("ProcessImageWorker", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  test("returns the image of the child and passes the bytes intact", async () => {
    const childPath = childScript(
      "echo",
      reply('{ ok: true, result: { bytes: Uint8Array.from(job.input.bytes).reverse(), contentType: "image/webp" } }'),
    );

    const result = await new ProcessImageWorker({ childPath }).compress(input);

    expect(result?.contentType).toBe("image/webp");
    expect([...result!.bytes]).toEqual([4, 3, 2, 1]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("treats 'no saving' as a normal answer", async () => {
    const childPath = childScript("none", reply("{ ok: true, result: null }"));
    await expect(new ProcessImageWorker({ childPath }).compress(input)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("gives the child no secrets", async () => {
    process.env.IMAGE_TEST_SECRET = "secret";
    const childPath = childScript(
      "env",
      reply(
        'Object.keys(process.env).includes("IMAGE_TEST_SECRET") ? { ok: true, result: null } : { ok: false, reason: "clean " + Object.keys(process.env).join() }',
      ),
    );
    await new ProcessImageWorker({ childPath }).compress(input);
    delete process.env.IMAGE_TEST_SECRET;
    expect(warn.mock.calls[0]?.[0]).toMatch(/clean NODE_ENV/);
  });

  test("limits the heap of the child", async () => {
    const childPath = childScript("heap", reply('{ ok: false, reason: process.execArgv.join(" ") }'));
    await new ProcessImageWorker({ childPath }).compress(input);
    expect(warn.mock.calls[0]?.[0]).toMatch(/--max-old-space-size=512/);
  });

  test.each([
    ["a crash", "process.once('message', () => process.abort());"],
    ["a clean exit without a reply", "process.once('message', () => process.exit(0));"],
    ["an invalid reply", reply("{ wrong: true }")],
    ["a job failure", reply('{ ok: false, reason: "bad file" }')],
    ["a child that does not start", "throw new Error('boot');"],
  ])("survives %s and stores the original", async (name, body) => {
    const childPath = childScript(name.replaceAll(" ", "-"), body);
    await expect(new ProcessImageWorker({ childPath }).compress(input)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  test("kills a child that hangs", async () => {
    const childPath = childScript("hang", "process.once('message', () => setInterval(() => {}, 1000));");
    const started = Date.now();
    await expect(
      new ProcessImageWorker({ childPath, jobTimeoutMs: 200 }).compress(input),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out/);
  });

  const IMAGE_REPLY = '{ ok: true, result: { bytes: Uint8Array.from([1]), contentType: "image/webp" } }';

  /** Answers with an image after `ms`, so a null can come only from the worker. */
  const slowChild = (name = "slow", ms = 200, log?: string) =>
    childScript(
      name,
      `import { appendFileSync } from "node:fs";
       ${log ? `appendFileSync(${JSON.stringify(log)}, "s");` : ""}
       process.once("message", () => setTimeout(() => process.send(${IMAGE_REPLY}, undefined, undefined, () => process.exit(0)), ${ms}));`,
    );

  test("never runs more jobs than its slots", async () => {
    const childPath = childScript(
      "counter",
      `import { appendFileSync, readFileSync } from "node:fs";
       const log = ${JSON.stringify(path.join(folder, "counter.log"))};
       process.once("message", () => {
         appendFileSync(log, "s");
         setTimeout(() => { appendFileSync(log, "e"); process.send({ ok: true, result: null }, undefined, undefined, () => process.exit(0)); }, 100);
       });`,
    );
    const compressor = new ProcessImageWorker({ childPath, maxRunning: 2, maxWaiting: 16 });

    await Promise.all(Array.from({ length: 6 }, () => compressor.compress(input)));

    let running = 0;
    let peak = 0;
    for (const event of readFileSync(path.join(folder, "counter.log"), "utf8")) {
      running += event === "s" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(2);
  });

  test("answers null at once when the wait list is full", async () => {
    const compressor = new ProcessImageWorker({ childPath: slowChild(), maxRunning: 1, maxWaiting: 1 });

    const [running, waiting, refused] = [
      compressor.compress(input),
      compressor.compress(input),
      compressor.compress(input),
    ];

    await expect(refused).resolves.toBeNull();
    await expect(running).resolves.not.toBeNull();
    await expect(waiting).resolves.not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("gives up on a job that waits too long, starts no child for it, and frees its place", async () => {
    const log = path.join(folder, "wait.log");
    const compressor = new ProcessImageWorker({
      childPath: slowChild("long", 400, log),
      maxRunning: 1,
      maxWaiting: 1,
      maxWaitMs: 50,
    });

    const running = compressor.compress(input);
    const started = Date.now();
    await expect(compressor.compress(input)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(300);
    await expect(running).resolves.not.toBeNull();

    await expect(compressor.compress(input)).resolves.not.toBeNull();
    expect(readFileSync(log, "utf8")).toBe("ss");
  });

  test("frees its slot after a failure", async () => {
    const compressor = new ProcessImageWorker({
      childPath: childScript("fail", "process.once('message', () => process.exit(1));"),
      maxRunning: 1,
      maxWaiting: 0,
    });
    await compressor.compress(input);
    warn.mockClear();
    // With a leaked slot, this call would return at once and warn nothing.
    await compressor.compress(input);
    expect(warn).toHaveBeenCalledOnce();
  });

  describe("SVG cleaning", () => {
    const svgInput = { bytes: Uint8Array.from([60]), profile: "docs_image" } as const;

    test("returns the cleaned bytes of the child", async () => {
      const childPath = childScript(
        "svg-echo",
        reply('{ ok: true, result: { bytes: Uint8Array.from(job.input.bytes), removedCount: job.kind === "clean_svg" ? 2 : 0 } }'),
      );
      const result = await new ProcessImageWorker({ childPath }).clean(svgInput);
      expect(result).toMatchObject({ removedCount: 2 });
      expect([...result!.bytes]).toEqual([60]);
    });

    test("answers null for an invalid SVG", async () => {
      const childPath = childScript("svg-invalid", reply("{ ok: true, result: null }"));
      await expect(new ProcessImageWorker({ childPath }).clean(svgInput)).resolves.toBeNull();
    });

    test.each([
      ["a crash", "process.once('message', () => process.abort());"],
      ["a job failure", reply('{ ok: false, reason: "bad" }')],
      ["an invalid reply", reply("{ ok: true, result: { bytes: 'not bytes', removedCount: 0 } }")],
    ])("rejects on %s, so nothing uncleaned is stored", async (name, body) => {
      const childPath = childScript(`svg-${name.replaceAll(" ", "-")}`, body);
      await expect(new ProcessImageWorker({ childPath }).clean(svgInput)).rejects.toThrow();
    });

    test("rejects when a parse hangs, and stops it", async () => {
      const childPath = childScript("svg-hang", "process.once('message', () => { for (;;) {} });");
      await expect(
        new ProcessImageWorker({ childPath, jobTimeoutMs: 200 }).clean(svgInput),
      ).rejects.toThrow(/timed out/);
    });

    test("rejects when no slot is free", async () => {
      const worker = new ProcessImageWorker({ childPath: slowChild(), maxRunning: 1, maxWaiting: 0 });
      const running = worker.compress(input);
      await expect(worker.clean(svgInput)).rejects.toThrow(/No free image worker/);
      await running;
    });
  });

});
