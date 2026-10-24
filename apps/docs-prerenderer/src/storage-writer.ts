import {
  DOCS_PRERENDER_LIMITS,
  createPrerenderManifestKey,
  createPrerenderObjectKey,
  parsePrerenderManifestV1,
  samePrerenderIdentity,
  type PrerenderManifestV1,
  type PrerenderIdentity,
  type PrerenderObjectReference,
} from "@doxahq/contracts/docs-prerender";

interface StoredObject {
  readonly etag: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface PutCondition {
  etagDoesNotMatch?: "*";
  etagMatches?: string;
}

export interface PrerenderWriteBucket {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: PutCondition },
  ): Promise<unknown | null>;
}

interface CommitPrerenderOutputInput {
  bucket: PrerenderWriteBucket;
  manifest: PrerenderManifestV1;
  objects: readonly Uint8Array[];
}

export type CommitPrerenderOutputResult =
  | { status: "committed" }
  | { status: "already_complete" };

export async function inspectPrerenderManifest(input: {
  bucket: PrerenderWriteBucket;
  identity: PrerenderIdentity;
}): Promise<{ status: "complete" | "missing" | "invalid" }> {
  const key = createPrerenderManifestKey(
    input.identity.siteId,
    input.identity.renderId,
  );
  const object = await input.bucket.get(key);
  if (!object) return { status: "missing" };
  if (object.size > DOCS_PRERENDER_LIMITS.manifestBytes) {
    return { status: "invalid" };
  }
  try {
    const manifest = parsePrerenderManifestV1(
      JSON.parse(new TextDecoder().decode(await object.arrayBuffer())),
    );
    return samePrerenderIdentity(manifest.identity, input.identity)
      ? { status: "complete" }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export async function writePrerenderObject(input: {
  bucket: PrerenderWriteBucket;
  identity: PrerenderIdentity;
  bytes: Uint8Array;
  extension: "html" | "json";
}): Promise<PrerenderObjectReference> {
  const limit =
    input.extension === "html"
      ? DOCS_PRERENDER_LIMITS.htmlBytes
      : DOCS_PRERENDER_LIMITS.jsonBytes;
  if (input.bytes.byteLength > limit) {
    throw new Error(`The ${input.extension} object exceeds the size limit.`);
  }
  const digest = await sha256(input.bytes);
  const key = createPrerenderObjectKey(
    input.identity.siteId,
    input.identity.renderId,
    digest,
    input.extension,
  );
  const observed = await input.bucket.get(key);
  if (
    !(
      observed &&
      (await isStoredObjectValid(observed, digest, input.bytes.byteLength))
    )
  ) {
    const result = await input.bucket.put(key, input.bytes, {
      onlyIf: observed
        ? { etagMatches: observed.etag }
        : { etagDoesNotMatch: "*" },
    });
    if (result === null) {
      const current = await input.bucket.get(key);
      if (
        !current ||
        !(await isStoredObjectValid(current, digest, input.bytes.byteLength))
      ) {
        throw new Error("A concurrent writer replaced a pre-render object.");
      }
    }
  }
  await verifyStoredObject(input.bucket, key, digest, input.bytes.byteLength);
  return {
    digest,
    byteLength: input.bytes.byteLength,
    contentType:
      input.extension === "html"
        ? "text/html; charset=utf-8"
        : "application/json; charset=utf-8",
    objectName: `objects/${digest}.${input.extension}`,
  };
}

export async function commitPrerenderManifest(input: {
  bucket: PrerenderWriteBucket;
  manifest: PrerenderManifestV1;
}): Promise<CommitPrerenderOutputResult> {
  const manifest = parsePrerenderManifestV1(input.manifest);
  const manifestKey = createPrerenderManifestKey(
    manifest.identity.siteId,
    manifest.identity.renderId,
  );
  const observedManifest = await input.bucket.get(manifestKey);
  if (
    observedManifest &&
    (await isCompleteManifest(observedManifest, manifest))
  ) {
    return { status: "already_complete" };
  }
  const manifestBytes = encodeJson(manifest);
  if (manifestBytes.byteLength > DOCS_PRERENDER_LIMITS.manifestBytes) {
    throw new Error("The pre-render manifest exceeds the size limit.");
  }
  const condition = observedManifest
    ? { etagMatches: observedManifest.etag }
    : { etagDoesNotMatch: "*" as const };
  const result = await input.bucket.put(manifestKey, manifestBytes, {
    onlyIf: condition,
  });
  if (result !== null) return { status: "committed" };

  const current = await input.bucket.get(manifestKey);
  if (current && (await isCompleteManifest(current, manifest))) {
    return { status: "already_complete" };
  }
  throw new Error("A concurrent writer replaced the pre-render manifest.");
}

/**
 * Writes immutable route bodies first and exposes readiness by committing the
 * complete manifest last. Conditional writes fence concurrent/stale writers.
 */
export async function commitPrerenderOutput(
  input: CommitPrerenderOutputInput,
): Promise<CommitPrerenderOutputResult> {
  const manifest = parsePrerenderManifestV1(input.manifest);
  const manifestKey = createPrerenderManifestKey(
    manifest.identity.siteId,
    manifest.identity.renderId,
  );
  const observedManifest = await input.bucket.get(manifestKey);
  if (
    observedManifest &&
    (await isCompleteManifest(observedManifest, manifest))
  ) {
    return { status: "already_complete" };
  }

  const suppliedObjects = await indexSuppliedObjects(input.objects);
  const references = manifest.routes.flatMap((route) => {
    if (route.kind === "live_only") return [];
    if (route.kind === "redirect")
      return [{ reference: route.data, extension: "json" as const }];
    return [
      { reference: route.html, extension: "html" as const },
      { reference: route.data, extension: "json" as const },
    ];
  });

  for (const { reference, extension } of references) {
    const body = suppliedObjects.get(reference.digest);
    if (!body || body.byteLength !== reference.byteLength) {
      throw new Error(
        "A referenced object body is missing or has the wrong size.",
      );
    }
    const stored = await writePrerenderObject({
      bucket: input.bucket,
      identity: manifest.identity,
      bytes: body,
      extension,
    });
    if (
      stored.digest !== reference.digest ||
      stored.byteLength !== reference.byteLength ||
      stored.objectName !== reference.objectName
    ) {
      throw new Error("A referenced object does not match the manifest.");
    }
  }
  return commitPrerenderManifest({ bucket: input.bucket, manifest });
}

async function indexSuppliedObjects(
  objects: readonly Uint8Array[],
): Promise<Map<string, Uint8Array>> {
  const indexed = new Map<string, Uint8Array>();
  for (const object of objects) indexed.set(await sha256(object), object);
  return indexed;
}

async function verifyStoredObject(
  bucket: PrerenderWriteBucket,
  key: string,
  expectedDigest: string,
  expectedBytes: number,
): Promise<void> {
  const object = await bucket.get(key);
  if (
    !object ||
    !(await isStoredObjectValid(object, expectedDigest, expectedBytes))
  ) {
    throw new Error("A referenced object could not be verified after writing.");
  }
}

async function isStoredObjectValid(
  object: StoredObject,
  expectedDigest: string,
  expectedBytes: number,
): Promise<boolean> {
  if (object.size !== expectedBytes) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return (
    bytes.byteLength === expectedBytes &&
    (await sha256(bytes)) === expectedDigest
  );
}

async function isCompleteManifest(
  object: StoredObject,
  expected: PrerenderManifestV1,
): Promise<boolean> {
  if (object.size > DOCS_PRERENDER_LIMITS.manifestBytes) return false;
  try {
    const parsed = parsePrerenderManifestV1(
      JSON.parse(new TextDecoder().decode(await object.arrayBuffer())),
    );
    return samePrerenderIdentity(parsed.identity, expected.identity);
  } catch {
    return false;
  }
}

function encodeJson(value: PrerenderManifestV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
