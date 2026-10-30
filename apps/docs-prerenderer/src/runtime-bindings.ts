import type { DocsHostResolution } from "@doxahq/contracts";
import type { PublicDocsRouteDataV1 } from "@doxahq/contracts/docs-prerender";
import type {
  PrerenderTaskApiRpc,
  PrerenderTaskPayload,
} from "@doxahq/contracts/docs-prerender-tasks";

export interface PrerenderRendererService {
  getPlan(input: { resolution: DocsHostResolution }): Promise<unknown>;
  prepare(input: {
    resolution: DocsHostResolution;
    pathname: string;
  }): Promise<unknown>;
  render(input: {
    resolution: DocsHostResolution;
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response>;
}

export interface Env {
  DOCS_RENDERED_BUCKET: R2Bucket;
  PRERENDER_WORKFLOW: Workflow<PrerenderTaskPayload>;
  PRERENDER_RENDERER: PrerenderRendererService;
  PRERENDER_TASKS: PrerenderTaskApiRpc;
  DOXA_RENDERER_RELEASE_ID: string;
}

export function createRendererAdapter(
  service: PrerenderRendererService,
  taskResolution: DocsHostResolution,
  /** The trusted origin of the render identity: the task's own hostname. */
  siteUrl: string,
): {
  getPlan(): Promise<unknown>;
  prepare(pathname: string): Promise<unknown>;
  render(input: {
    pathname: string;
    requestUrl: string;
    renderId: string;
    routeData: PublicDocsRouteDataV1;
  }): Promise<Response>;
} {
  const resolution: DocsHostResolution = { ...taskResolution, siteUrl };
  return {
    getPlan: () => service.getPlan({ resolution }),
    prepare: (pathname) => service.prepare({ resolution, pathname }),
    render: (input) => service.render({ resolution, ...input }),
  };
}

export function createBucketAdapter(bucket: R2Bucket): {
  get(key: string): Promise<{
    etag: string;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  put(
    key: string,
    value: Uint8Array,
    options: { onlyIf: { etagDoesNotMatch?: "*"; etagMatches?: string } },
  ): Promise<unknown | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: readonly { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
} {
  return {
    get: async (key) => {
      const object = await bucket.get(key);
      return object
        ? {
            etag: object.etag,
            size: object.size,
            arrayBuffer: () => object.arrayBuffer(),
          }
        : null;
    },
    put: (key, value, options) => bucket.put(key, value, options),
    list: async (options) => {
      const listed = await bucket.list(options);
      return {
        objects: listed.objects.map((object) => ({ key: object.key })),
        truncated: listed.truncated,
        ...(listed.truncated && listed.cursor
          ? { cursor: listed.cursor }
          : {}),
      };
    },
    delete: (keys) => bucket.delete(keys),
  };
}
