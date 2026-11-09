import { setPriority } from "node:os";
import sharp from "sharp";
import { cleanSvgBytes } from "../../../services/site-assets/image-content";
import { childJobSchema, type ChildJob, type ChildReply } from "./child-protocol";
import { compressRaster } from "./compress-raster";

/**
 * One image job, in its own process. The parent starts this file with an
 * empty environment, so a bug in an image decoder or in the XML parser finds
 * no secrets here.
 */

const BACKGROUND_PRIORITY = 10;
const MAX_REASON_LENGTH = 200;

/** The upload paths send only PNG and JPEG. No other decoder can run. */
function restrictDecoders(): void {
  sharp.block({ operation: ["VipsForeignLoad"] });
  sharp.unblock({ operation: ["VipsForeignLoadPngBuffer", "VipsForeignLoadJpegBuffer"] });
}

function runJob(job: ChildJob): Promise<unknown> | unknown {
  return job.kind === "compress"
    ? compressRaster(job.input)
    : cleanSvgBytes(job.input.bytes, job.input.profile);
}

async function reply(message: unknown): Promise<ChildReply> {
  try {
    return { ok: true, result: await runJob(childJobSchema.parse(message)) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: reason.slice(0, MAX_REASON_LENGTH) };
  }
}

// The API keeps the CPU while a job runs.
setPriority(BACKGROUND_PRIORITY);
sharp.cache(false);
sharp.concurrency(1);
restrictDecoders();

process.on("disconnect", () => process.exit(1));
process.once("message", (message: unknown) => {
  void reply(message).then((answer) => {
    process.send?.(answer, undefined, undefined, () => process.exit(0));
  });
});
