import { z } from "zod";
import { compressedImageSchema, imageCompressionInputSchema } from "../../../services/site-assets/image-compression";
import { cleanedSvgBytesSchema, svgCleaningInputSchema } from "../../../services/site-assets/image-content";

/** The one job that a child process runs. */
export const childJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compress"), input: imageCompressionInputSchema }).strict(),
  z.object({ kind: z.literal("clean_svg"), input: svgCleaningInputSchema }).strict(),
]);
export type ChildJob = z.infer<typeof childJobSchema>;

export const compressResultSchema = compressedImageSchema.nullable();
export const cleanSvgResultSchema = cleanedSvgBytesSchema.nullable();

/** The one message that a child process sends back. Each job checks its own `result`. */
export const childReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
export type ChildReply = z.infer<typeof childReplySchema>;
