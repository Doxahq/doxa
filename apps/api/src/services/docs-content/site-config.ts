import { readSiteConfig, type DocsManifest } from "@doxahq/docs-engine";
import {
  createValidationIssue,
  type ResolvedSiteConfig,
  type SiteAssetKind,
  type ValidationIssue,
} from "@doxahq/site-config";
import type { PublishedDocsContentVersion } from "../../repositories/docs-content";
import type { EntitlementsService } from "../entitlements";
import type { SiteAssetStore } from "../site-assets/store";
import {
  SiteConfigValidationError,
  validateSiteConfig,
} from "../site-config-validation";
import type { DocsContentStore } from "./store";

export function readPublishedSiteConfig(
  store: DocsContentStore,
  version: Pick<PublishedDocsContentVersion, "artifactPrefix" | "projectName">,
  manifest: DocsManifest,
) {
  return readSiteConfig(
    { read: (key) => store.readBytes(key) },
    {
      artifactPrefix: version.artifactPrefix,
      projectName: version.projectName,
      manifest,
    },
  );
}

export async function validateConfigForSite(
  input: unknown,
  version: Pick<PublishedDocsContentVersion, "projectId" | "siteId">,
  entitlements: EntitlementsService,
  assets: Pick<SiteAssetStore, "head">,
): Promise<ResolvedSiteConfig> {
  const config = validateSiteConfig(input);
  const issues: ValidationIssue[] = [];
  const plan = await entitlements.getProjectEntitlements(version.projectId);
  if (!config.branding.poweredBy && !plan.removePoweredBy)
    issues.push(
      createValidationIssue("entitlement_required", "/branding/poweredBy"),
    );
  const fields: Array<{
    ref: string | null;
    kind: SiteAssetKind;
    path: string;
  }> = [
    {
      ref: config.branding.logo.light,
      kind: "logo",
      path: "/branding/logo/light",
    },
    {
      ref: config.branding.logo.dark,
      kind: "logo",
      path: "/branding/logo/dark",
    },
    {
      ref: config.branding.favicon,
      kind: "favicon",
      path: "/branding/favicon",
    },
    {
      ref: config.branding.ogImage,
      kind: "ogImage",
      path: "/branding/ogImage",
    },
  ];
  const assetIssues = await Promise.all(
    fields.map(async ({ ref, kind, path }) => {
      if (!ref) return [];
      const stored = await assets.head(
        version.siteId,
        ref.slice("asset:".length),
      );
      if (!stored) return [createValidationIssue("asset_not_found", path)];
      return stored.kind === kind
        ? []
        : [createValidationIssue("asset_wrong_kind", path)];
    }),
  );
  issues.push(...assetIssues.flat());
  if (issues.length) throw new SiteConfigValidationError(issues);
  return config;
}
