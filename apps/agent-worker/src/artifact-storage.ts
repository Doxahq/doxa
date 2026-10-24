import {
  VersionTreeWriter,
  createVersionTreeReader,
  sharedVersionTreeCache,
  type RuntimeDocsArtifactFile,
  type VersionTreeReader,
} from "@doxahq/docs-engine";

const readers = new WeakMap<object, VersionTreeReader>();

/** Reads logical artifact keys through the version tree of each folder. */
export function artifactReader(bucket: R2Bucket): VersionTreeReader {
  let reader = readers.get(bucket);

  if (!reader) {
    reader = createVersionTreeReader(bucket, {
      cache: sharedVersionTreeCache(bucket),
    });
    readers.set(bucket, reader);
  }

  return reader;
}

/**
 * Stores generated files as one immutable version: blobs first, the version
 * tree last. A retried workflow step writes the same blobs and the same tree
 * again, so the step stays idempotent.
 */
export async function writeArtifactVersion(
  bucket: R2Bucket,
  input: {
    siteId: string;
    versionId: string;
    files: readonly RuntimeDocsArtifactFile[];
    /** Runs before each file, for example to stop a cancelled job. */
    beforeEachFile?: () => Promise<void>;
  },
): Promise<{ artifactPrefix: string; manifestPath: string }> {
  const writer = new VersionTreeWriter(bucket, {
    siteId: input.siteId,
    versionId: input.versionId,
  });

  for (const file of input.files) {
    await input.beforeEachFile?.();
    await writer.put(file.path, file.content, file.contentType);
  }

  const { artifactPrefix, manifestPath } = await writer.commit();
  return { artifactPrefix, manifestPath };
}
