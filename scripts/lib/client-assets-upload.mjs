import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Old client assets (M27). Every renderer deploy puts the hashed client files
 * of its build into the renderer code bucket. A page that a visitor loaded
 * before a later deploy still finds its old files there, through the
 * dispatcher's `DocsClientAssetCache`. A 30-day lifecycle rule on the
 * `client-assets/` prefix deletes them.
 *
 * Keep the prefix in sync with `CLIENT_ASSET_KEY_PREFIX` in
 * apps/docs-dispatcher/src/client-asset-cache-entrypoint.ts.
 */
export const CLIENT_ASSET_KEY_PREFIX = "client-assets/v1/assets/";
export const CLIENT_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const CLIENT_ASSET_UPLOAD_CONCURRENCY = 6;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const CONTENT_TYPES = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** Every file under the assets directory, as sorted POSIX paths. */
export async function listClientAssetFiles(assetsDirectory) {
  const files = await listFiles(assetsDirectory, "");
  return files.sort();
}

async function listFiles(root, relativeDirectory) {
  const entries = await readdir(path.join(root, relativeDirectory), {
    withFileTypes: true,
  });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return listFiles(root, relativePath);
      return entry.isFile() ? [relativePath] : [];
    }),
  );
  return nested.flat();
}

export function contentTypeForClientAsset(file) {
  return (
    CONTENT_TYPES.get(path.posix.extname(file).toLowerCase()) ??
    DEFAULT_CONTENT_TYPE
  );
}

/** One upload per file: its local path, object key and content type. */
export function planClientAssetUploads({ assetsDirectory, files }) {
  if (files.length === 0) {
    throw new Error(`No client assets found in ${assetsDirectory}.`);
  }
  return files.map((file) => ({
    file,
    filePath: path.join(assetsDirectory, ...file.split("/")),
    key: `${CLIENT_ASSET_KEY_PREFIX}${file}`,
    contentType: contentTypeForClientAsset(file),
  }));
}

/** The `pnpm` arguments that put one planned file into the bucket. */
export function createClientAssetPutArgs(bucket, upload) {
  return [
    "exec",
    "wrangler",
    "r2",
    "object",
    "put",
    `${bucket}/${upload.key}`,
    "--file",
    upload.filePath,
    "--content-type",
    upload.contentType,
    "--cache-control",
    CLIENT_ASSET_CACHE_CONTROL,
    "--remote",
    "--force",
  ];
}

/**
 * Runs the uploads with at most `concurrency` at a time. `run(args, upload)`
 * runs one `pnpm` command. After the first failure no new upload starts, and
 * the returned promise rejects.
 */
export async function uploadClientAssets({
  uploads,
  bucket,
  run,
  concurrency = CLIENT_ASSET_UPLOAD_CONCURRENCY,
}) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < uploads.length) {
      const upload = uploads[next];
      next += 1;
      try {
        await run(createClientAssetPutArgs(bucket, upload), upload);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, uploads.length) },
    worker,
  );
  await Promise.all(workers);
  return uploads.length;
}

/**
 * Runs one `pnpm` command. Output is printed only when the command fails, so
 * six parallel uploads do not mix their progress lines.
 */
export function runQuietCommand(command, args, { cwd, label, description }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) {
        globalThis.console.log(`[${label}] ${description}`);
        resolve();
        return;
      }
      globalThis.console.error(Buffer.concat(output).toString("utf8"));
      reject(
        new Error(`${command} ${args.join(" ")} exited with ${status ?? 1}.`),
      );
    });
  });
}
