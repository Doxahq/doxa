import type {
  DocsAccessPolicy,
  DocsPreviewVisibility,
} from "@doxahq/contracts";

/**
 * Access policy of a published production hostname.
 *
 * Production documentation has no generation preview gate. This helper keeps
 * one source of truth, so a later change to the gate reaches every caller.
 */
export function resolveProductionDocsAccessPolicy(input: {
  gateEnabled: boolean;
}): DocsAccessPolicy {
  return resolveDocsAccessPolicy({
    isGenerationPreview: false,
    previewVisibility: "private",
    gateEnabled: input.gateEnabled,
  });
}

export function resolveDocsAccessPolicy(input: {
  isGenerationPreview: boolean;
  previewVisibility: DocsPreviewVisibility;
  gateEnabled: boolean;
}): DocsAccessPolicy {
  if (!input.isGenerationPreview) return "public";
  // The current session cookie cannot cross from doxa.so to doxa.page.
  // Keep the gate off until a signed token exchange replaces that cookie.
  if (!input.gateEnabled) return "public";
  return input.previewVisibility === "public" ? "public" : "authenticated";
}
