import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runJobMain } from "@doxahq/utility-kit/job";
import { jobFailure, jobSuccess } from "@doxahq/utility-kit/outcome";
import { decodeSpecReaderInput } from "./input";
import { readSpecs } from "./read-specs";

/** The SHA-256 of this bundle. The job folder is the one folder the child may read. */
const readerVersion = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");

/** The entry of the job child: one call, input on stdin, outcome on stdout. */
await runJobMain((bytes) => {
  const decoded = decodeSpecReaderInput(bytes);
  return decoded.ok
    ? jobSuccess(readSpecs(decoded.input, readerVersion))
    : jobFailure("invalid_input", decoded.message);
});
