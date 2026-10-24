import { assertSafeObjectKeys } from "@doxahq/contracts/docs-prerender";
import {
  createDefaultSiteConfig,
  parseSiteConfigLenient,
  resolveSiteConfig,
  upgradeV1SiteConfig,
  SITE_CONFIG_LIMITS,
  type ResolvedSiteConfig,
} from "@doxahq/site-config";
import type { DocsManifest } from "./manifest";

export interface SiteConfigStorageReader {
  read(path: string): Promise<Uint8Array | null>;
}

export interface SiteConfigReadContext {
  artifactPrefix: string;
  manifest: DocsManifest;
  projectName: string;
}

type ConfigReadEvent = {
  event:
    | "site_config_integrity_mismatch"
    | "site_config_fields_dropped"
    | "site_config_invalid";
  artifactPrefix: string;
  paths?: string[];
};

/** One reader for runtime requests, content edits, and generation baselines. */
export async function readSiteConfig(
  storage: SiteConfigStorageReader,
  context: SiteConfigReadContext,
  log: (event: ConfigReadEvent) => void = (event) =>
    console.warn(JSON.stringify(event)),
): Promise<ResolvedSiteConfig> {
  if (context.manifest.schemaVersion === 1)
    return readLegacyConfig(storage, context);

  const fallback = () => resolveSiteConfig(createDefaultSiteConfig(context));
  const raw = await storage.read(
    `${context.artifactPrefix}/${context.manifest.siteConfig.path}`,
  );
  if (!raw || (await sha256(raw)) !== context.manifest.siteConfig.sha256) {
    log({
      event: "site_config_integrity_mismatch",
      artifactPrefix: context.artifactPrefix,
    });
    return fallback();
  }
  try {
    if (raw.byteLength > SITE_CONFIG_LIMITS.configBytes)
      throw new Error("Config exceeds byte limit");
    const input: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    assertSafeObjectKeys(input);
    const { config, droppedPaths } = parseSiteConfigLenient(input);
    if (droppedPaths.length) {
      log({
        event: "site_config_fields_dropped",
        artifactPrefix: context.artifactPrefix,
        paths: droppedPaths,
      });
    }
    return config;
  } catch {
    log({
      event: "site_config_invalid",
      artifactPrefix: context.artifactPrefix,
    });
    return fallback();
  }
}

async function readLegacyConfig(
  storage: SiteConfigStorageReader,
  context: SiteConfigReadContext,
) {
  const raw = await storage.read(
    `${context.artifactPrefix}/settings/features.json`,
  );
  let features: unknown;
  try {
    features = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined;
    assertSafeObjectKeys(features);
  } catch {
    features = undefined;
  }
  return resolveSiteConfig({
    ...upgradeV1SiteConfig({
      projectName: context.manifest.projectSlug,
      features,
    }),
    // Published v1 titles and descriptions are part of the frozen contract.
    description: `Documentation for ${context.manifest.projectSlug}.`,
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
