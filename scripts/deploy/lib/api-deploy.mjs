// Pure parts of scripts/deploy-api.mjs: the image tag, the renderer release
// and the commands of a deploy. The script runs them; the tests check them.

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

/**
 * The steps of a deploy, in order:
 *   1. build and push the image, unless ECR has it or --image names one;
 *   2. roll the origin out on ECS (it waits until the new task is healthy);
 *   3. deploy the edge Worker, which then serves api.doxa.so.
 * The origin goes first: the edge forwards to whatever the origin runs.
 */
export function deploySteps({ image, build, rendererRelease }) {
  const steps = [];
  if (build) {
    steps.push({
      name: "image",
      command: "docker",
      args: ["buildx", "build", "--platform", "linux/arm64", "-f", "apps/api/Dockerfile", "-t", image, "--push", "."],
    });
  }
  const originArgs = ["scripts/deploy-api-ecs.mjs", "--image", image];
  if (rendererRelease) originArgs.push("--env", `DOXA_RENDERER_RELEASE_ID=${rendererRelease}`);
  steps.push({ name: "origin", command: process.execPath, args: originArgs });
  steps.push({
    name: "edge",
    command: "pnpm",
    args: ["--filter", "@doxahq/api-edge", "exec", "wrangler", "deploy", "--env", "production"],
  });
  return steps;
}
