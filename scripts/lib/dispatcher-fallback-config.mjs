// Checks of the committed docs dispatcher vars for pre-rendering (M36) and
// the previous-build fallback (M26). Used by validate-production-config.mjs.

const ROLLOUT_MODES = ["off", "allowlist", "all"];
const MAX_WINDOW_SECONDS = 7 * 86_400;

/**
 * M36 rolls out per site from the committed config: package-renderer keeps
 * it unless a deploy passes another value (F1).
 */
export function validatePrerenderRollout(vars, label) {
  if (!ROLLOUT_MODES.includes(vars?.DOXA_PROD_PRERENDER_MODE)) {
    throw new Error(
      `${label} must set DOXA_PROD_PRERENDER_MODE to off, allowlist or all.`,
    );
  }
  if (
    vars.DOXA_PROD_PRERENDER_MODE === "allowlist" &&
    !vars.DOXA_PROD_PRERENDER_SITE_IDS
  ) {
    throw new Error(
      `${label} must list DOXA_PROD_PRERENDER_SITE_IDS for the pre-render allowlist.`,
    );
  }
}

/**
 * M26 (the previous-build fallback) and the warm rollout it reads. A typo
 * fails closed to off at runtime, so only the documented values pass. The
 * previous-build values come from the deploy (deploy-renderer.mjs), never
 * from the committed config.
 */
export function validatePreviousFallbackVars(vars, label) {
  if (!["off", "shadow", "on"].includes(vars?.DOXA_PROD_PREVIOUS_FALLBACK_MODE)) {
    throw new Error(
      `${label} must set DOXA_PROD_PREVIOUS_FALLBACK_MODE to off, shadow or on.`,
    );
  }
  const window = Number(vars?.DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS);
  if (!Number.isInteger(window) || window <= 0 || window > MAX_WINDOW_SECONDS) {
    throw new Error(
      `${label} must set DOXA_PREVIOUS_FALLBACK_BUILD_WINDOW_SECONDS to whole seconds between 1 and 604800.`,
    );
  }
  if (!ROLLOUT_MODES.includes(vars?.DOXA_PROD_WARM_MODE)) {
    throw new Error(`${label} must set DOXA_PROD_WARM_MODE to off, allowlist or all.`);
  }
  if (typeof vars?.DOXA_PROD_WARM_SITE_IDS !== "string") {
    throw new Error(`${label} must define DOXA_PROD_WARM_SITE_IDS.`);
  }
  for (const name of [
    "DOXA_PREVIOUS_RENDERER_BUILD_ID",
    "DOXA_PREVIOUS_RENDERER_RELEASE_ID",
    "DOXA_RENDERER_DEPLOYED_AT",
  ]) {
    if (vars?.[name] !== "") {
      throw new Error(
        `${label} must leave ${name} empty; the renderer deploy sets it.`,
      );
    }
  }
}
