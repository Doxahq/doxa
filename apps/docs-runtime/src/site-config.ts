import { readSiteConfig as readArtifactSiteConfig } from "@doxahq/docs-engine";
import type { ResolvedSiteConfig } from "@doxahq/site-config";
import {
  readText,
  recordArtifactRead,
  type RuntimeSourceEnv,
  type ProjectRuntimeContext,
  type RuntimeRequestContext,
} from "./runtime-source";

const MAX_CONFIGS = 256;
const configs = new Map<string, Promise<ResolvedSiteConfig>>();

export function resetSiteConfigCacheForTests(): void {
  configs.clear();
}

export function readSiteConfig(
  env: RuntimeSourceEnv,
  context: ProjectRuntimeContext,
  runtimeContext: RuntimeRequestContext,
): Promise<ResolvedSiteConfig> {
  const key = context.artifactPrefix;
  const existing = configs.get(key);
  if (existing) {
    configs.delete(key);
    configs.set(key, existing);
    return existing;
  }
  const pending = readArtifactSiteConfig(
    {
      read: async (path) => {
        if (context.manifest.schemaVersion === 2) {
          const startedAt = performance.now();
          const object = await runtimeContext.timing.measure(
            "siteConfig.bucketGet",
            () => runtimeContext.artifacts.get(path),
          );
          recordArtifactRead(runtimeContext, performance.now() - startedAt);
          if (object) return new Uint8Array(await object.arrayBuffer());
        }
        // Local development can store artifacts behind the internal API fallback.
        const text = await readText(env, path, runtimeContext);
        return text === null ? null : new TextEncoder().encode(text);
      },
    },
    { ...context, projectName: context.projectSlug },
  );
  configs.set(key, pending);
  if (configs.size > MAX_CONFIGS) {
    const oldest = configs.keys().next().value;
    if (oldest !== undefined) configs.delete(oldest);
  }
  void pending.catch(() => {
    if (configs.get(key) === pending) configs.delete(key);
  });
  return pending;
}

/** Keep the legacy RPC feature shape stable; the resolved config carries all flags. */
export function runtimeFeatures(config: ResolvedSiteConfig) {
  const { AgressiveNavPrefetch: _prefetch, ...features } = config.features;
  return features;
}
