import sharp, { type Sharp } from "sharp";
import { describe, expect, test } from "vitest";
import { compressRaster } from "../../../src/runtime/node/image-processing/compress-raster";
import type { ImageCompressionInput } from "../../../src/services/site-assets/image-compression";

/** A flat page with colored bands: the shape of a UI screenshot. */
function uiImage(width: number, height: number, channels: 3 | 4 = 3) {
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const band = Math.floor(y / 12) % 6;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      raw[offset] = band * 40;
      raw[offset + 1] = 255 - band * 30;
      raw[offset + 2] = (x >> 5) % 2 ? 200 : 60;
      if (channels === 4) raw[offset + 3] = x < width / 2 ? 0 : 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels } });
}

/** Noise compresses badly, so it makes a file that needs bytes to look right. */
function photoImage(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  let state = 12345;
  for (let index = 0; index < raw.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    raw[index] = 80 + ((state >>> 16) % 90);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

const uploaded = (
  bytes: Uint8Array,
  contentType: ImageCompressionInput["contentType"],
  profile: ImageCompressionInput["profile"] = "docs_image",
): ImageCompressionInput => ({ bytes, contentType, profile });

async function pngInput(image: Sharp, profile?: ImageCompressionInput["profile"]) {
  return uploaded(await image.png({ compressionLevel: 0 }).toBuffer(), "image/png", profile);
}

describe("compressRaster", () => {
  test("makes a screenshot PNG much smaller and keeps its size", async () => {
    const input = await pngInput(uiImage(800, 600));

    const result = await compressRaster(input);

    expect(result).not.toBeNull();
    expect(result!.bytes.byteLength).toBeLessThan(input.bytes.byteLength * 0.5);
    expect(await sharp(result!.bytes).metadata()).toMatchObject({ width: 800, height: 600 });
  });

  test("gives the same bytes for the same upload, so a re-upload dedupes", async () => {
    const input = await pngInput(uiImage(400, 300));
    const [first, second] = [await compressRaster(input), await compressRaster(input)];
    expect(Buffer.from(first!.bytes).equals(Buffer.from(second!.bytes))).toBe(true);
  });

  test("converts a photo JPEG only to WebP", async () => {
    const bytes = await photoImage(600, 400).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    const result = await compressRaster(uploaded(bytes, "image/jpeg"));
    expect(result?.contentType).toBe("image/webp");
  });

  test("scales a wide docs image to 2400 pixels, but never enlarges one", async () => {
    const wide = await compressRaster(await pngInput(uiImage(3000, 200)));
    expect((await sharp(wide!.bytes).metadata()).width).toBe(2400);

    const narrow = await compressRaster(await pngInput(uiImage(500, 200)));
    expect((await sharp(narrow!.bytes).metadata()).width).toBe(500);
  });

  test("does not scale a logo", async () => {
    const result = await compressRaster(await pngInput(uiImage(3000, 200), "logo"));
    expect((await sharp(result!.bytes).metadata()).width).toBe(3000);
  });

  test("keeps the format of an OG image, because crawlers differ", async () => {
    const png = await compressRaster(await pngInput(uiImage(1200, 630), "og_image"));
    expect(png?.contentType).toBe("image/png");

    const jpegBytes = await photoImage(1200, 630).jpeg({ quality: 100 }).toBuffer();
    const jpeg = await compressRaster(uploaded(jpegBytes, "image/jpeg", "og_image"));
    expect(jpeg?.contentType).toBe("image/jpeg");
  });

  test("keeps transparency", async () => {
    const result = await compressRaster(await pngInput(uiImage(400, 300, 4)));
    const pixels = await sharp(result!.bytes).ensureAlpha().raw().toBuffer();
    expect(pixels[3]).toBe(0);
    expect(pixels[399 * 4 + 3]).toBe(255);
  });

  test("keeps the original when the saving is under 10%", async () => {
    // A low-quality JPEG is already small: a WebP at quality 90 is not smaller.
    const bytes = await photoImage(300, 200).jpeg({ quality: 30 }).toBuffer();
    await expect(compressRaster(uploaded(bytes, "image/jpeg"))).resolves.toBeNull();
  });

  test("applies the EXIF orientation before it removes the tag", async () => {
    const bytes = await photoImage(300, 100).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
    const result = await compressRaster(uploaded(bytes, "image/jpeg"));
    const metadata = await sharp(result!.bytes).metadata();
    expect(metadata).toMatchObject({ width: 100, height: 300 });
    expect(metadata.orientation).toBeUndefined();
  });

  test("removes EXIF data such as a GPS position", async () => {
    const bytes = await photoImage(300, 100)
      .withExif({ IFD3: { GPSLatitude: "36/1 45/1 0/1", GPSLatitudeRef: "N" } })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();

    const result = await compressRaster(uploaded(bytes, "image/jpeg"));
    expect((await sharp(result!.bytes).metadata()).exif).toBeUndefined();
  });

  test("uses palette PNG for an image too tall for WebP", async () => {
    const result = await compressRaster(await pngInput(uiImage(500, 17_000)));
    expect(result?.contentType).toBe("image/png");
  });

  test("leaves a CMYK JPEG without a profile alone, because its colors are unknown", async () => {
    const bytes = await photoImage(300, 200).toColourspace("cmyk").jpeg().toBuffer();
    expect((await sharp(bytes).metadata()).space).toBe("cmyk");
    await expect(compressRaster(uploaded(bytes, "image/jpeg"))).resolves.toBeNull();
  });

  test("refuses a small file that declares a huge canvas", async () => {
    const { bytes } = uploaded(
      await sharp({
        create: { width: 7000, height: 7000, channels: 3, background: "#ffffff" },
        limitInputPixels: false,
      })
        .png()
        .toBuffer(),
      "image/png",
    );
    expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(compressRaster(uploaded(bytes, "image/png"))).rejects.toThrow(/pixel limit/i);
  });

  test.each([
    ["wider than 16383 pixels", 16_384, 1],
    ["taller than 32767 pixels", 1, 32_768],
  ])("leaves an image %s alone, before it decodes the image", async (_name, width, height) => {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
      .png({ palette: true })
      .toBuffer();
    await expect(compressRaster(uploaded(bytes, "image/png"))).resolves.toBeNull();
  });

  test("refuses a damaged file", async () => {
    const whole = (await pngInput(uiImage(400, 300))).bytes;
    await expect(
      compressRaster(uploaded(whole.subarray(0, whole.byteLength / 2), "image/png")),
    ).rejects.toThrow();
  });
});
