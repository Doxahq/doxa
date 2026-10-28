import { getRequestHost } from "@tanstack/react-start/server";

import {
  createBindingRuntimeSource,
  type BindingRuntimeResolution,
  type DocsContentBinding,
} from "./binding-runtime-source";
import type { PlatformRuntimeSourceConfig } from "./platform-runtime-source";
import type { DoxaDocsRuntimeSource } from "./runtime-source";
import { isRuntimeTimingEnabled } from "./runtime-timing";

export type RuntimeSourceMode = "vite" | "platform" | "binding";

type RuntimeSourceEnv = Record<string, string | undefined>;

/**
 * `requestHost` is the `Host` of the current request, for callers that run
 * before TanStack Start: its request context, which `getRequestHost` reads,
 * does not exist yet there.
 */
export async function createConfiguredRuntimeSource(
  env: RuntimeSourceEnv = process.env,
  requestHost?: string
): Promise<DoxaDocsRuntimeSource> {
  const mode = getRuntimeSourceMode(env);

  switch (mode) {
    case "vite": {
      if (import.meta.env.DOXA_OMIT_LOCAL_CONTENT_SOURCE) {
        throw new Error(
          'This renderer build has no local content source. Set DOXA_DOCS_RUNTIME_SOURCE to "binding" or "platform".'
        );
      }
      const { viteRuntimeSource } = await import("./vite");
      return viteRuntimeSource;
    }
    case "platform": {
      const { createPlatformRuntimeSource } = await import("./platform");
      return createPlatformRuntimeSource(
        getPlatformRuntimeSourceConfig(env, requestHost)
      );
    }
    case "binding":
      throw new Error(
        "Binding runtime mode requires a dispatcher-scoped runtime source."
      );
  }
}

export function getRuntimeSourceMode(
  env: RuntimeSourceEnv = process.env
): RuntimeSourceMode {
  const source =
    env.DOXA_DOCS_RUNTIME_SOURCE ??
    env.DOXA_RUNTIME_SOURCE ??
    env.RUNTIME_SOURCE ??
    "vite";

  if (source === "vite" || source === "platform" || source === "binding") {
    return source;
  }

  throw new Error(
    `Unknown DOXA_DOCS_RUNTIME_SOURCE: "${source}". Expected "vite", "platform", or "binding".`
  );
}

export interface RendererWorkerEnv {
  DOXA_DOCS_RUNTIME_SOURCE?: string;
  DOXA_DOCS_CONTENT_BINDING?: DocsContentBinding;
  DOXA_DOCS_CONTENT_RESOLUTION?: BindingRuntimeResolution;
}

/**
 * The content of one request, which the dispatcher passes as entrypoint props
 * when one renderer isolate serves many sites. The binding is pinned to the
 * resolution by the dispatcher and works only during this request.
 */
export interface RendererRequestScope {
  content: DocsContentBinding;
  resolution: BindingRuntimeResolution;
}

export interface DispatcherRuntimeSourceOptions {
  /** Content scope of this request. It wins over the isolate's `env`. */
  requestScope?: RendererRequestScope;
  /** Fallback for the shared renderer, which resolves by hostname. */
  hostname?: string;
}

/** Reads the request scope from entrypoint props. Any other shape is absent. */
export function readRendererRequestScope(
  props: unknown
): RendererRequestScope | undefined {
  if (!isRecord(props)) return undefined;
  const { content, resolution } = props;
  if (!isDocsContentBinding(content) || !isBindingResolution(resolution)) {
    return undefined;
  }
  return { content, resolution };
}

export function createDispatcherRuntimeSource(
  env: RendererWorkerEnv | undefined,
  { requestScope, hostname }: DispatcherRuntimeSourceOptions = {}
): DoxaDocsRuntimeSource | undefined {
  if (env?.DOXA_DOCS_RUNTIME_SOURCE !== "binding") return undefined;
  if (requestScope) {
    return createBindingRuntimeSource({
      binding: requestScope.content,
      resolution: requestScope.resolution,
    });
  }
  if (!env.DOXA_DOCS_CONTENT_BINDING) {
    throw new Error("Binding runtime mode requires a content binding.");
  }

  if (env.DOXA_DOCS_CONTENT_RESOLUTION) {
    return createBindingRuntimeSource({
      binding: env.DOXA_DOCS_CONTENT_BINDING,
      resolution: env.DOXA_DOCS_CONTENT_RESOLUTION,
    });
  }
  if (hostname) {
    return createBindingRuntimeSource({
      binding: env.DOXA_DOCS_CONTENT_BINDING,
      hostname,
    });
  }

  throw new Error(
    "Binding runtime mode requires a pinned resolution or request hostname."
  );
}

export function getPlatformRuntimeSourceConfig(
  env: RuntimeSourceEnv = process.env,
  requestHost?: string
): PlatformRuntimeSourceConfig {
  const hostname =
    readRuntimeEnv(env, [
      "DOXA_DOCS_CONTENT_HOSTNAME",
      "DOXA_PLATFORM_HOSTNAME",
    ]) ??
    (requestHost?.trim() || undefined) ??
    readRequestHostname();
  const projectId = readRuntimeEnv(env, [
    "DOXA_DOCS_CONTENT_PROJECT_ID",
    "DOXA_PLATFORM_PROJECT_ID",
  ]);

  return {
    contentWorkerUrl: requireRuntimeEnv(env, [
      "DOXA_DOCS_CONTENT_WORKER_URL",
      "DOXA_PLATFORM_CONTENT_URL",
    ]),
    accessToken: requireRuntimeEnv(env, [
      "DOXA_DOCS_CONTENT_TOKEN",
      "DOXA_PLATFORM_CONTENT_TOKEN",
    ]),
    ...(hostname ? { hostname } : {}),
    ...(projectId ? { projectId } : {}),
    runtimePath:
      env.DOXA_DOCS_CONTENT_RUNTIME_PATH ??
      env.DOXA_PLATFORM_CONTENT_RUNTIME_PATH,
    timingEnabled: isRuntimeTimingEnabled(env),
  };
}

function readRuntimeEnv(
  env: RuntimeSourceEnv,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  return undefined;
}

function requireRuntimeEnv(env: RuntimeSourceEnv, names: string[]): string {
  const value = readRuntimeEnv(env, names);
  if (value) return value;

  throw new Error(
    `Missing required platform runtime env var. Set one of: ${names.join(", ")}.`
  );
}

function readRequestHostname(): string | undefined {
  try {
    const hostname = getRequestHost({ xForwardedHost: false }).trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDocsContentBinding(value: unknown): value is DocsContentBinding {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return false;
  }
  // An RPC stub resolves its methods when they are read.
  const request: unknown = Reflect.get(value, "request");
  return typeof request === "function";
}

const BINDING_RESOLUTION_STRING_FIELDS = [
  "siteId",
  "projectId",
  "projectSlug",
  "publishedVersionId",
  "artifactPrefix",
  "manifestPath",
] as const satisfies readonly (keyof BindingRuntimeResolution)[];

function isBindingResolution(
  value: unknown
): value is BindingRuntimeResolution {
  if (!isRecord(value)) return false;
  return (
    BINDING_RESOLUTION_STRING_FIELDS.every(
      (field) => typeof value[field] === "string" && value[field] !== ""
    ) &&
    (value.accessPolicy === "public" || value.accessPolicy === "authenticated")
  );
}
