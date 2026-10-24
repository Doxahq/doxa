import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC_READER_JOB } from "@doxahq/contracts/spec-reader";
import { startSupervisor } from "@doxahq/utility-kit/supervisor";

/** The process of the spec-reader image. The job bundle sits beside this file. */
const entry = fileURLToPath(new URL("./job.mjs", import.meta.url));

startSupervisor({
  job: SPEC_READER_JOB.name,
  port: SPEC_READER_JOB.port,
  entry,
  readDirectory: dirname(entry),
  heapMb: SPEC_READER_JOB.heapMb,
  timeoutMs: SPEC_READER_JOB.childTimeoutMs,
  maxRequestBytes: SPEC_READER_JOB.maxRequestBytes,
  maxOutputBytes: SPEC_READER_JOB.maxOutputBytes,
});
