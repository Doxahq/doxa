import {
  DOCS_PRERENDER_LIMITS,
  createPrerenderManifestKey,
  createPrerenderObjectKey,
  parsePrerenderManifestV1,
  samePrerenderIdentity,
  parsePublicDocsRouteDataV1,
  type PrerenderIdentity,
  type PrerenderObjectReference,
  type PublicDocsRouteDataV1,
} from "@doxahq/contracts/docs-prerender";

interface ReadableR2Object {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PrerenderReadBucket {
  get(key: string): Promise<ReadableR2Object | null>;
}

export type PrerenderRouteLookup =
  | {
      status: "hit";
      html?: Uint8Array;
      data?: Uint8Array;
      routeData?: PublicDocsRouteDataV1;
      redirect?: { href: string; status: 301 | 302 | 303 | 307 | 308 };
      routeKind: "page" | "redirect";
    }
  | { status: "miss"; reason: "manifest_missing" | "unknown_route" }
  | { status: "live_only"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "unavailable"; reason: "deadline" | "storage_error" };

interface ReadPrerenderedRouteInput {
  bucket: PrerenderReadBucket;
  expected: PrerenderIdentity;
  pathname: string;
  /**
   * "html" reads the page body only. "data" reads the route data only. A
   * request never pays for the representation it does not return.
   */
  representation: "html" | "data";
  deadlineMs?: number;
  timing?: PrerenderLookupTiming;
}

interface PrerenderLookupTiming {
  measure<T>(
    name: string,
    operation: () => Promise<T> | T,
    description?: string | (() => string | undefined),
  ): Promise<T>;
}

export async function readPrerenderedRoute(
  input: ReadPrerenderedRouteInput,
): Promise<PrerenderRouteLookup> {
  let lookupDescription = "unavailable:storage_error";
  return measureLookupStep(
    input.timing,
    "doxa_prerender_lookup",
    async () => {
      const result = await readPrerenderedRouteWithinDeadline(input);
      lookupDescription = describeLookup(result);
      return result;
    },
    () => lookupDescription,
  );
}

async function readPrerenderedRouteWithinDeadline(
  input: ReadPrerenderedRouteInput,
): Promise<PrerenderRouteLookup> {
  const deadlineAt =
    Date.now() + (input.deadlineMs ?? DOCS_PRERENDER_LIMITS.lookupDeadlineMs);
  try {
    let manifestGetStatus = "ERROR";
    const manifestObject = await measureLookupStep(
      input.timing,
      "doxa_prerender_manifest_get",
      async () => {
        const object = await getBeforeDeadline(
          input.bucket,
          createPrerenderManifestKey(
            input.expected.siteId,
            input.expected.renderId,
          ),
          deadlineAt,
        );
        manifestGetStatus = object ? "HIT" : "MISS";
        return object;
      },
      () => manifestGetStatus,
    );
    if (!manifestObject) return { status: "miss", reason: "manifest_missing" };
    const manifestBytes = await measureLookupStep(
      input.timing,
      "doxa_prerender_manifest_read",
      () =>
        readBoundedObject(
          manifestObject,
          DOCS_PRERENDER_LIMITS.manifestBytes,
          deadlineAt,
        ),
    );
    const manifest = await measureLookupStep(
      input.timing,
      "doxa_prerender_manifest_parse",
      () =>
        parsePrerenderManifestV1(
          JSON.parse(new TextDecoder().decode(manifestBytes)),
        ),
    );
    if (!samePrerenderIdentity(manifest.identity, input.expected)) {
      return { status: "invalid", reason: "identity_mismatch" };
    }

    const route = manifest.routes.find(
      (candidate) => candidate.pathname === input.pathname,
    );
    if (!route) return { status: "miss", reason: "unknown_route" };
    if (route.kind === "live_only") {
      return { status: "live_only", reason: route.reason };
    }

    if (route.kind === "redirect" && input.representation === "html") {
      // The manifest entry is identity-bound and schema-checked, and it
      // carries the target and the status. A redirect needs no object read.
      return {
        status: "hit",
        redirect: { href: route.target, status: route.status },
        routeKind: "redirect",
      };
    }

    if (input.representation === "data") {
      const data = await readReferencedObject(
        input.bucket,
        input.expected,
        route.data,
        "json",
        deadlineAt,
        input.timing,
      );
      if (data.status !== "ok") return data.result;
      const routeData = await measureLookupStep(
        input.timing,
        "doxa_prerender_data_parse",
        () =>
          parsePublicDocsRouteDataV1(
            JSON.parse(new TextDecoder().decode(data.bytes)),
          ),
      );
      if (route.kind === "redirect") {
        if (
          routeData.type !== "redirect" ||
          routeData.href !== route.target ||
          routeData.status !== route.status
        ) {
          return { status: "invalid", reason: "redirect_data_mismatch" };
        }
        return {
          status: "hit",
          data: data.bytes,
          routeData,
          redirect: { href: route.target, status: route.status },
          routeKind: "redirect",
        };
      }
      return {
        status: "hit",
        data: data.bytes,
        routeData,
        routeKind: "page",
      };
    }

    if (route.kind !== "page") {
      return { status: "invalid", reason: "unexpected_route_kind" };
    }
    const html = await readReferencedObject(
      input.bucket,
      input.expected,
      route.html,
      "html",
      deadlineAt,
      input.timing,
    );
    if (html.status !== "ok") return html.result;
    return {
      status: "hit",
      html: html.bytes,
      routeKind: "page",
    };
  } catch (error) {
    if (error instanceof PrerenderDeadlineError) {
      return { status: "unavailable", reason: "deadline" };
    }
    return { status: "unavailable", reason: "storage_error" };
  }
}

type ReferencedObjectRead =
  | { status: "ok"; bytes: Uint8Array }
  | {
      status: "failed";
      result: Extract<PrerenderRouteLookup, { status: "invalid" }>;
    };

async function readReferencedObject(
  bucket: PrerenderReadBucket,
  identity: PrerenderIdentity,
  reference: PrerenderObjectReference,
  extension: "html" | "json",
  deadlineAt: number,
  timing?: PrerenderLookupTiming,
): Promise<ReferencedObjectRead> {
  const objectKind = extension === "html" ? "html" : "data";
  const expectedName = `objects/${reference.digest}.${extension}`;
  if (reference.objectName !== expectedName) {
    return {
      status: "failed",
      result: { status: "invalid", reason: "object_name_mismatch" },
    };
  }
  let getStatus = "ERROR";
  const object = await measureLookupStep(
    timing,
    `doxa_prerender_${objectKind}_get`,
    async () => {
      const storedObject = await getBeforeDeadline(
        bucket,
        createPrerenderObjectKey(
          identity.siteId,
          identity.renderId,
          reference.digest,
          extension,
        ),
        deadlineAt,
      );
      getStatus = storedObject ? "HIT" : "MISS";
      return storedObject;
    },
    () => getStatus,
  );
  if (!object) {
    return {
      status: "failed",
      result: { status: "invalid", reason: "object_missing" },
    };
  }
  const limit =
    extension === "html"
      ? DOCS_PRERENDER_LIMITS.htmlBytes
      : DOCS_PRERENDER_LIMITS.jsonBytes;
  let bytes: Uint8Array;
  try {
    bytes = await measureLookupStep(
      timing,
      `doxa_prerender_${objectKind}_read`,
      () => readBoundedObject(object, limit, deadlineAt),
    );
  } catch (error) {
    if (error instanceof PrerenderDeadlineError) throw error;
    return {
      status: "failed",
      result: { status: "invalid", reason: "object_size_invalid" },
    };
  }
  if (bytes.byteLength !== reference.byteLength) {
    return {
      status: "failed",
      result: { status: "invalid", reason: "object_size_mismatch" },
    };
  }
  const digest = await measureLookupStep(
    timing,
    `doxa_prerender_${objectKind}_hash`,
    () => sha256(bytes),
  );
  if (digest !== reference.digest) {
    return {
      status: "failed",
      result: { status: "invalid", reason: "object_digest_mismatch" },
    };
  }
  return { status: "ok", bytes };
}

function describeLookup(lookup: PrerenderRouteLookup): string {
  return "reason" in lookup
    ? `${lookup.status}:${lookup.reason}`
    : lookup.status;
}

function measureLookupStep<T>(
  timing: PrerenderLookupTiming | undefined,
  name: string,
  operation: () => Promise<T> | T,
  description?: string | (() => string | undefined),
): Promise<T> {
  if (timing) return timing.measure(name, operation, description);
  return Promise.resolve(operation());
}

async function getBeforeDeadline(
  bucket: PrerenderReadBucket,
  key: string,
  deadlineAt: number,
): Promise<ReadableR2Object | null> {
  return beforeDeadline(bucket.get(key), deadlineAt);
}

async function readBoundedObject(
  object: ReadableR2Object,
  limit: number,
  deadlineAt: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > limit
  ) {
    throw new Error("Stored object size is outside the allowed bounds.");
  }
  const buffer = await beforeDeadline(object.arrayBuffer(), deadlineAt);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength > limit) {
    throw new Error("Stored object body exceeds the allowed bounds.");
  }
  return bytes;
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new PrerenderDeadlineError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new PrerenderDeadlineError()),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

class PrerenderDeadlineError extends Error {}

/** The part of an R2 bucket that a readiness check needs. */
export interface PrerenderHeadBucket {
  head(key: string): Promise<unknown>;
}

/**
 * Is the saved output of this identity committed? One `head` of the
 * manifest, which the pre-renderer writes last. The warm job checks this
 * before it fills `DocsPrerenderCache` keys (F21): a call through the cache
 * entrypoint would store 30-second entries and submit repairs instead.
 */
export async function hasPrerenderManifest(
  bucket: PrerenderHeadBucket,
  identity: PrerenderIdentity,
): Promise<boolean> {
  const object = await bucket.head(
    createPrerenderManifestKey(identity.siteId, identity.renderId),
  );
  return object !== null && object !== undefined;
}
