import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEC_CONTENT_TYPE,
  ORIGIN_KEY_HEADER,
  callRemote,
} from "@doxahq/api-bridge";
import * as esbuild from "esbuild";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Env } from "../../../src/env";
import { ProcessImageWorker } from "../../../src/runtime/node/image-processing/process-image-worker";
import { API_ENTRYPOINTS, createRpcHandler } from "../../../src/runtime/node/rpc-handler";
import { compressedImageSchema } from "../../../src/services/site-assets/image-compression";

/** The real child, built as the server build builds it, and the real encoder. */

// The Node build aliases cloudflare:workers to this shim. The tests do the same.
vi.mock("cloudflare:workers", () => import("../../../src/runtime/node/workers-shim"));

const apiRoot = fileURLToPath(new URL("../../..", import.meta.url));
const ORIGIN_KEY = "k".repeat(40);
let folder: string;
let compressor: ProcessImageWorker;

beforeAll(async () => {
  // Inside apps/api, so the built child resolves `sharp`.
  folder = mkdtempSync(path.join(apiRoot, "node_modules/.image-compressor-test-"));
  const childPath = path.join(folder, "child.mjs");
  await esbuild.build({
    entryPoints: [path.join(apiRoot, "src/runtime/node/image-processing/child.ts")],
    outfile: childPath,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["sharp"],
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "silent",
  });
  compressor = new ProcessImageWorker({ childPath, jobTimeoutMs: 30_000 });
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

function screenshotPng(width = 800, height = 600) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 3) {
    const band = Math.floor(index / 3 / width / 12) % 6;
    raw[index] = band * 40;
    raw[index + 1] = 255 - band * 30;
    raw[index + 2] = 120;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

describe("the real compression child", () => {
  test("compresses a PNG, and the reply is a usable image", async () => {
    const bytes = await screenshotPng();

    const result = await compressor.compress({ bytes, contentType: "image/png", profile: "docs_image" });

    expect(result).not.toBeNull();
    expect(result!.bytes.byteLength).toBeLessThan(bytes.byteLength / 2);
    expect(await sharp(result!.bytes).metadata()).toMatchObject({ width: 800, height: 600 });
  });

  test("cannot decode any format except PNG and JPEG", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#336699" } })
      .gif()
      .toBuffer();

    // The label is a lie on purpose: the decoder restriction must hold anyway.
    await expect(
      compressor.compress({ bytes: gif, contentType: "image/png", profile: "docs_image" }),
    ).resolves.toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/unsupported image format/);
    warn.mockRestore();
  });

  test("refuses a pixel bomb without decoding it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bomb = await sharp({
      create: { width: 7000, height: 7000, channels: 3, background: "#ffffff" },
      limitInputPixels: false,
    })
      .png()
      .toBuffer();

    await expect(
      compressor.compress({ bytes: bomb, contentType: "image/png", profile: "docs_image" }),
    ).resolves.toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/pixel limit/);
    warn.mockRestore();
  });
});

describe("the real child cleans SVG", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const svg = (body: string) => encode(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

  test("keeps the allowlist and reports what it removed", async () => {
    const result = await compressor.clean({
      bytes: svg('<path d="M0 0"/><script>x</script>'),
      profile: "docs_image",
    });
    expect(decode(result!.bytes)).toContain("<path");
    expect(decode(result!.bytes)).not.toContain("script");
    expect(result!.removedCount).toBe(1);
  });

  test("cleans a large real-sized diagram within the heap limit", async () => {
    const bytes = svg('<path d="M0 0L10 10" fill="#333"/>'.repeat(50_000));
    const result = await compressor.clean({ bytes, profile: "docs_image" });
    expect(result?.removedCount).toBe(0);
  }, 30_000);

  test("answers null for a file that is not SVG", async () => {
    await expect(
      compressor.clean({ bytes: encode("plain text"), profile: "docs_image" }),
    ).resolves.toBeNull();
  });

  test("answers null for nesting past the limit, without a long parse", async () => {
    const started = performance.now();
    await expect(
      compressor.clean({ bytes: svg("<g>".repeat(200_000) + "</g>".repeat(200_000)), profile: "docs_image" }),
    ).resolves.toBeNull();
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("keeps the API thread free while it cleans the largest file it accepts", async () => {
    const bytes = svg("x<g/>".repeat(99_000));
    let longestStall = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      longestStall = Math.max(longestStall, now - last);
      last = now;
    }, 5);
    const result = await compressor.clean({ bytes, profile: "docs_image" });
    clearInterval(probe);
    expect(result).not.toBeNull();
    expect(longestStall).toBeLessThan(250);
  }, 30_000);
});

describe("compressImage over the origin RPC", () => {
  const rpc = (args: readonly unknown[], env: Partial<Env>) => {
    const handler = createRpcHandler({
      env: env as Env,
      originKey: ORIGIN_KEY,
      createExecutionContext: () => ({}) as ExecutionContext,
      entrypoints: API_ENTRYPOINTS,
    });
    return callRemote(
      {
        fetch: (request) => handler(request),
        url: "http://origin/__rpc/AgentActionsApi/compressImage",
        keyHeader: ORIGIN_KEY_HEADER,
        key: ORIGIN_KEY,
      },
      args,
    );
  };

  test("carries the largest image and returns a real result", async () => {
    // Noise makes the raw PNG fill the 2 MB limit.
    const width = 800;
    const height = 800;
    const raw = Buffer.alloc(width * height * 3);
    let state = 7;
    for (let index = 0; index < raw.length; index++) {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      raw[index] = state >>> 16;
    }
    const bytes = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(bytes.byteLength).toBeGreaterThan(1.5 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);

    const result = await rpc([{ bytes, contentType: "image/png", profile: "docs_image" }], {
      IMAGE_COMPRESSOR: compressor,
    });

    const image = compressedImageSchema.parse(result);
    expect(image.bytes.byteLength).toBeLessThan(bytes.byteLength);
  }, 30_000);

  test("answers null for input that is not an upload, and never throws", async () => {
    await expect(rpc([{ bytes: "not bytes" }], { IMAGE_COMPRESSOR: compressor })).resolves.toBeNull();
  });

  test("answers null on a runtime with no encoder", async () => {
    const bytes = await screenshotPng(40, 40);
    await expect(rpc([{ bytes, contentType: "image/png", profile: "logo" }], {})).resolves.toBeNull();
  });

  test("still needs the origin key", async () => {
    const handler = createRpcHandler({
      env: {} as Env,
      originKey: ORIGIN_KEY,
      createExecutionContext: () => ({}) as ExecutionContext,
    });
    const response = await handler(
      new Request("http://origin/__rpc/AgentActionsApi/compressImage", {
        method: "POST",
        headers: { "content-type": CODEC_CONTENT_TYPE },
        body: "[]",
      }),
    );
    expect(response.status).toBe(401);
  });
});
