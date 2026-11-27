// Pure parts of scripts/deploy/deploy-api.mjs: the image tag, the renderer release
// and the arguments of its commands. The script runs them; the tests check them.

/** The renderer release writes this file with DOXA_RENDERER_RELEASE_ID set. */
export const RENDERER_RELEASE_CONFIG = "apps/api/dist/wrangler.production.json";
const RELEASE_ID = /^[\w.:-]{1,128}$/;
const PLACEHOLDER_RELEASE = "unconfigured";

/**
 * The tag of an image built from this tree: the 12-character commit, and a
 * time stamp when the tree has changes, so an ECR tag never names two images.
 */
export function imageTagFor({ commit, dirty, now = new Date() }) {
  if (!/^[0-9a-f]{12}$/.test(commit)) throw new Error(`"${commit}" is not a 12-character git commit.`);
  if (!dirty) return commit;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${commit}-dirty-${stamp}`;
}

/** DOXA_RENDERER_RELEASE_ID of a generated API config, or an error when it is missing. */
export function rendererReleaseOf(config) {
  const release = config?.env?.production?.vars?.DOXA_RENDERER_RELEASE_ID;
  return assertRendererRelease(release);
}

export function assertRendererRelease(release) {
  if (typeof release !== "string" || !RELEASE_ID.test(release) || release === PLACEHOLDER_RELEASE) {
    throw new Error(`"${release}" is not a renderer release ID.`);
  }
  return release;
}

/** The edge Worker, as `wrangler deploy` and `wrangler versions upload` name it. */
export const EDGE_TARGET = Object.freeze({ cwd: "apps/api-edge", args: Object.freeze(["--env", "production"]) });

/** The `docker` arguments that build the image for Graviton and push it. */
export function imageBuildArgs(image) {
  return ["buildx", "build", "--platform", "linux/arm64", "-f", "apps/api/Dockerfile", "-t", image, "--push", "."];
}

/**
 * The scripts/deploy/deploy-api-ecs.mjs arguments that start an image on the idle
 * color. The origin carries the release ID and, when the renderer release
 * gives one, the renderer release ID.
 *
 * @param {{ image: string, color: string, releaseId: string, rendererRelease?: string, outputFile: string }} options
 */
export function originStartArgs({ image, color, releaseId, rendererRelease, outputFile }) {
  const args = ["scripts/deploy/deploy-api-ecs.mjs", "--color", color, "--image", image, "--env", `DOXA_RELEASE_ID=${releaseId}`];
  if (rendererRelease) args.push("--env", `DOXA_RENDERER_RELEASE_ID=${rendererRelease}`);
  args.push("--output", outputFile);
  return args;
}

/**
 * The edge variables of a release: the origin color it sends traffic to,
 * and the release ID that it sends to the origin.
 *
 * @param {{ color: string, releaseId: string }} options
 * @returns {Record<string, string>}
 */
export function edgeVars({ color, releaseId }) {
  return { ORIGIN_COLOR: color, DOXA_RELEASE_ID: releaseId };
}
