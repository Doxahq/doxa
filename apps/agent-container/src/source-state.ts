import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  GENERATION_STATE_SCHEMA_VERSION,
  generationSourceStateSchema,
  type GenerationSourceState,
  type RepositorySnapshot,
  type SourceFileHash,
} from "@doxahq/contracts";

export async function captureGenerationSourceState(
  checkoutPath: string,
  snapshot: RepositorySnapshot,
): Promise<GenerationSourceState> {
  const files = await listFiles(checkoutPath);
  const hashes: SourceFileHash[] = [];
  for (const path of files) {
    hashes.push(await hashSourceFile(checkoutPath, path));
  }
  hashes.sort((left, right) => compareStrings(left.path, right.path));
  return generationSourceStateSchema.parse({
    schemaVersion: GENERATION_STATE_SCHEMA_VERSION,
    sourceRevision: snapshot.targetRevision,
    sourceTreeHash: snapshot.sourceTreeHash,
    files: hashes,
  });
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relative(root, fullPath).replace(/\\/g, "/"));
    }
  }
  return files;
}

async function hashSourceFile(
  checkoutRoot: string,
  path: string,
): Promise<SourceFileHash> {
  const hash = createHash("sha256");
  let contentKind: SourceFileHash["contentKind"] = "text";
  let inspectedBytes = 0;
  for await (const chunk of createReadStream(join(checkoutRoot, path))) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    if (contentKind === "text" && inspectedBytes < 8_192) {
      const remaining = Math.min(bytes.length, 8_192 - inspectedBytes);
      if (bytes.subarray(0, remaining).includes(0)) {
        contentKind = "binary";
      }
      inspectedBytes += remaining;
    }
  }
  return {
    path,
    contentHash: hash.digest("hex"),
    contentKind,
  };
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
