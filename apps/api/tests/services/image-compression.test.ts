import { describe, expect, test, vi } from "vitest";
import {
  compressUploadedImage,
  isAnimatedPng,
  type ImageCompressor,
} from "../../src/services/site-assets/image-compression";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const WEBP_HEADER = [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32];

function chunk(type: string, dataLength = 0): number[] {
  return [0, 0, 0, dataLength, ...[...type].map((c) => c.charCodeAt(0)), ...new Array<number>(dataLength + 4).fill(0)];
}

const staticPng = (size = 200) =>
  Uint8Array.from([...PNG_SIGNATURE, ...chunk("IHDR", 13), ...chunk("IDAT", size)]);
const animatedPng = () =>
  Uint8Array.from([...PNG_SIGNATURE, ...chunk("IHDR", 13), ...chunk("acTL", 8), ...chunk("IDAT", 20)]);
const smallerWebp = () => Uint8Array.from(WEBP_HEADER);

function compressorReturning(result: Awaited<ReturnType<ImageCompressor["compress"]>>) {
  return { compress: vi.fn(async () => result) };
}

describe("compressUploadedImage", () => {
  test("returns a smaller file of the declared type", async () => {
    const bytes = smallerWebp();
    const compressor = compressorReturning({ bytes, contentType: "image/webp" });

    await expect(
      compressUploadedImage(compressor, { bytes: staticPng(), contentType: "image/png" }, "docs_image"),
    ).resolves.toEqual({ bytes, contentType: "image/webp" });
  });

  test.each(["image/webp", "image/gif", "image/x-icon", "image/svg+xml"])(
    "does not call the encoder for %s",
    async (contentType) => {
      const compressor = compressorReturning(null);
      await expect(
        compressUploadedImage(compressor, { bytes: staticPng(), contentType }, "docs_image"),
      ).resolves.toBeNull();
      expect(compressor.compress).not.toHaveBeenCalled();
    },
  );

  test("leaves an animated PNG alone, because an encoder keeps one frame", async () => {
    const compressor = compressorReturning(null);
    await compressUploadedImage(compressor, { bytes: animatedPng(), contentType: "image/png" }, "docs_image");
    expect(compressor.compress).not.toHaveBeenCalled();
  });

  test("works without a compressor", async () => {
    await expect(
      compressUploadedImage(null, { bytes: staticPng(), contentType: "image/png" }, "docs_image"),
    ).resolves.toBeNull();
  });

  test("never lets an encoder error fail the upload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const compressor = { compress: vi.fn(() => Promise.reject(new Error("decoder crashed"))) };

    await expect(
      compressUploadedImage(compressor, { bytes: staticPng(), contentType: "image/png" }, "docs_image"),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  test("refuses a result that is not smaller", async () => {
    const original = smallerWebp().slice(0, 16);
    const compressor = compressorReturning({ bytes: Uint8Array.from(WEBP_HEADER), contentType: "image/webp" });
    await expect(
      compressUploadedImage(compressor, { bytes: original, contentType: "image/png" }, "docs_image"),
    ).resolves.toBeNull();
  });

  test.each([
    ["an ICO result", [0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0], "image/x-icon"],
    ["a GIF result", [71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0], "image/gif"],
  ])("refuses %s, a type that an upload never stores after compression", async (_name, bytes, contentType) => {
    const compressor: ImageCompressor = {
      compress: vi.fn(async () => Object.assign({ bytes: Uint8Array.from(bytes) }, { contentType: contentType as "image/webp" })),
    };
    await expect(
      compressUploadedImage(compressor, { bytes: staticPng(), contentType: "image/png" }, "docs_image"),
    ).resolves.toBeNull();
  });

  test("refuses a result whose bytes differ from its declared type", async () => {
    const compressor = compressorReturning({ bytes: smallerWebp(), contentType: "image/png" });
    await expect(
      compressUploadedImage(compressor, { bytes: staticPng(), contentType: "image/png" }, "docs_image"),
    ).resolves.toBeNull();
  });
});

describe("isAnimatedPng", () => {
  test("finds acTL before the first image data", () => {
    expect(isAnimatedPng(animatedPng())).toBe(true);
    expect(isAnimatedPng(staticPng())).toBe(false);
  });

  test("ignores acTL after the image data", () => {
    const late = Uint8Array.from([...PNG_SIGNATURE, ...chunk("IDAT", 4), ...chunk("acTL", 8)]);
    expect(isAnimatedPng(late)).toBe(false);
  });

  test("stops on a truncated or oversized chunk", () => {
    expect(isAnimatedPng(Uint8Array.from(PNG_SIGNATURE))).toBe(false);
    expect(
      isAnimatedPng(Uint8Array.from([...PNG_SIGNATURE, 255, 255, 255, 255, 116, 69, 88, 116])),
    ).toBe(false);
  });
});
