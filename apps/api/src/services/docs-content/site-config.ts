import { readSiteConfig, type DocsManifest } from "@doxahq/docs-engine";
import {
  createValidationIssue,
  type ResolvedSiteConfig,
  type SiteAssetKind,
  type ValidationIssue,
} from "@doxahq/site-config";
import type { PublishedDocsContentVersion } from "../../repositories/docs-content";
import type { EntitlementsService } from "../entitlements";
import type { DocsSearchProvider } from "@doxahq/contracts/docs-search";
import { FREE_PLAN_SEARCH_POLICY } from "@doxahq/contracts/entitlements";
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

/**
 * SECURITY: an owner cannot choose a search provider that the plan does not
 * allow, through the dashboard, MCP, an agent or the JSON tab. The index worker
 * applies the plan again, so this check is not the only guard.
 *
 * It runs only on a save, and only for a new choice. A site that lost its plan
 * still holds its old choice, and it must stay able to save and to publish: the
 * worker gives it the plan's default. So `validateConfigForSite`, which every
 * publish runs, does not check this.
 */
export async function assertSearchChoiceAllowed(input: {
  choice: DocsSearchProvider | undefined;
  readPreviousChoice: () => Promise<unknown>;
  projectId: string;
  entitlements: EntitlementsService;
}): Promise<void> {
  if (!input.choice) return;
  const policy =
    (await input.entitlements.getSearchPolicy?.(input.projectId)) ??
    FREE_PLAN_SEARCH_POLICY;
  const allowed: readonly DocsSearchProvider[] = policy.allowedProviders;
  if (allowed.includes(input.choice)) return;
  if ((await input.readPreviousChoice()) === input.choice) return;
  throw new SiteConfigValidationError([
    createValidationIssue("entitlement_required", "/features/searchProvider"),
  ]);
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
