import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { sha256Hex } from "@doxahq/docs-engine";

/** One file of the archive and how to read its bytes. */
export interface ZipStreamFile {
  path: string;
  /** The expected sha256 of the bytes, or null when the bytes are made here. */
  sha256: string | null;
  size: number | null;
  read(): Promise<Uint8Array>;
}

export interface ZipStreamOptions {
  files: readonly ZipStreamFile[];
  /** The modification time of every entry, so one version always gives the same archive. */
  mtime: Date;
  /** Reads that run ahead of the zip writer. */
  concurrency?: number;
  /** After the last byte is in the stream. */
  onComplete?: () => void;
  /**
   * A read or the writer failed. The stream errors after this call.
   * `bytesSent` is how much of the archive was already in the stream.
   */
  onError?: (cause: unknown, progress: { bytesSent: number }) => void;
  /** The client went away before the end, or `signal` aborted. */
  onCancel?: () => void;
  /** Stops the export, for example at a time limit. Counts as a cancel. */
  signal?: AbortSignal;
  /**
   * Stops the export when the client reads nothing for this long, so a
   * client that stays connected but never reads cannot hold its slot.
   * Counts as a cancel.
   */
  idleTimeoutMs?: number;
}

export class ExportIntegrityError extends Error {
  constructor(path: string, problem: string) {
    super(`The export file ${path} ${problem}.`);
    this.name = "ExportIntegrityError";
  }
}

const DEFAULT_CONCURRENCY = 4;
/**
 * Deflate is synchronous. A file goes in pieces of this size, with a yield to
 * the event loop between them, so one large file never stalls the API.
 */
const DEFLATE_CHUNK_BYTES = 256 * 1024;

/** Text files compress well. Images and fonts are already compressed. */
const COMPRESSED_EXTENSIONS = /\.(mdx|md|json|txt|css|js|svg|html|xml|yml|yaml)$/i;

/**
 * Streams a zip archive. It is pull-based: the next file is read only when
 * the consumer wants more bytes, so a slow download never holds more than
 * `concurrency` files in memory. Each read is checked against its expected
 * size and sha256 before it enters the archive.
 */
export function createZipStream(options: ZipStreamOptions): ReadableStream<Uint8Array> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const pending: { file: ZipStreamFile; bytes: Promise<Uint8Array> }[] = [];
  let nextIndex = 0;
  let ended = false;
  let failed = false;
  let bytesSent = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener = () => {};
  let zip: Zip;

  const finish = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    removeAbortListener();
  };

  const fill = () => {
    while (pending.length < concurrency && nextIndex < options.files.length) {
      const file = options.files[nextIndex];
      nextIndex += 1;
      if (!file) continue;
      const bytes = readChecked(file);
      // A read that fails after cancel must not become an unhandled rejection.
      bytes.catch(() => {});
      pending.push({ file, bytes });
    }
  };

  const stop = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ended || failed) return;
    failed = true;
    finish();
    pending.length = 0;
    try {
      zip.terminate();
    } catch {
      // The writer may already be closed.
    }
    options.onCancel?.();
    controller.error(new DOMException("The export stopped.", "AbortError"));
  };

  let armIdle = () => {};

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const signal = options.signal;
        if (signal) {
          if (signal.aborted) queueMicrotask(() => stop(controller));
          else {
            const onAbort = () => stop(controller);
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          }
        }
        armIdle = () => {
          if (!options.idleTimeoutMs) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => stop(controller), options.idleTimeoutMs);
        };
        armIdle();
        zip = new Zip((cause, chunk, final) => {
          if (failed) return;
          if (cause) {
            failed = true;
            finish();
            options.onError?.(cause, { bytesSent });
            controller.error(cause);
            return;
          }
          bytesSent += chunk.byteLength;
          controller.enqueue(chunk);
          if (final) {
            finish();
            controller.close();
            options.onComplete?.();
          }
        });
      },
      async pull(controller) {
        if (ended || failed) return;
        armIdle();
        fill();
        const next = pending.shift();
        if (!next) {
          ended = true;
          zip.end();
          return;
        }
        const { file } = next;
        try {
          const bytes = await next.bytes;
          if (failed) return;
          const entry = COMPRESSED_EXTENSIONS.test(file.path)
            ? new ZipDeflate(file.path, { level: 6 })
            : new ZipPassThrough(file.path);
          entry.mtime = options.mtime;
          zip.add(entry);
          let offset = 0;
          while (bytes.byteLength - offset > DEFLATE_CHUNK_BYTES) {
            entry.push(bytes.subarray(offset, offset + DEFLATE_CHUNK_BYTES), false);
            offset += DEFLATE_CHUNK_BYTES;
            await yieldToEventLoop();
            if (failed) return;
          }
          entry.push(bytes.subarray(offset), true);
        } catch (cause) {
          if (failed) return;
          failed = true;
          finish();
          options.onError?.(cause, { bytesSent });
          controller.error(cause);
        }
      },
      cancel() {
        if (ended && !failed) return;
        failed = true;
        finish();
        pending.length = 0;
        try {
          zip.terminate();
        } catch {
          // The writer may already be closed.
        }
        options.onCancel?.();
      },
    },
    { highWaterMark: 1 },
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readChecked(file: ZipStreamFile): Promise<Uint8Array> {
  const bytes = await file.read();
  if (file.size !== null && bytes.byteLength !== file.size) {
    throw new ExportIntegrityError(file.path, "has an unexpected size");
  }
  if (file.sha256 !== null && (await sha256Hex(bytes)) !== file.sha256) {
    throw new ExportIntegrityError(file.path, "does not match its sha256");
  }
  return bytes;
}
