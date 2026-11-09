import { describe, expect, test, vi } from "vitest";
import { createRemoteImageCompressor } from "../src/services/remote-image-compressor";

const input = { bytes: Uint8Array.from([1]), contentType: "image/png", profile: "docs_image" } as const;

describe("createRemoteImageCompressor", () => {
  test("returns the answer of the API", async () => {
    const image = { bytes: Uint8Array.from([9]), contentType: "image/webp" } as const;
    const compressImage = vi.fn(async () => image);

    await expect(createRemoteImageCompressor({ compressImage }).compress(input)).resolves.toBe(image);
    expect(compressImage).toHaveBeenCalledWith(input);
  });

  test("gives up after the time limit, so the upload stores the original", async () => {
    vi.useFakeTimers();
    const compressImage = () => new Promise<null>(() => undefined);
    const result = createRemoteImageCompressor({ compressImage }, 8_000).compress(input);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(result).resolves.toBeNull();
    vi.useRealTimers();
  });
});
