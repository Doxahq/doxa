import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RELEASE_ID_PATTERN = /^[a-f0-9]{64}$/;

export async function preparePrerenderConfigs(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const apiConfigPath = path.resolve(workspaceRoot, options.apiConfigPath);
  const apiOutputPath = path.resolve(workspaceRoot, options.apiOutputPath);
  const prerendererConfigPath = path.resolve(
    workspaceRoot,
    options.prerendererConfigPath,
  );
  const prerendererOutputPath = path.resolve(
    workspaceRoot,
    options.prerendererOutputPath,
  );
  const metadata = await readJson(
    path.resolve(workspaceRoot, options.metadataPath),
  );
  const releaseId = requireReleaseId(metadata.rendererReleaseId);
  const apiConfig = prepareGeneratedConfig(
    withApiRelease(await readJson(apiConfigPath), releaseId),
    apiConfigPath,
    apiOutputPath,
  );
  const prerendererConfig = prepareGeneratedConfig(
    withWorkerRelease(await readJson(prerendererConfigPath), releaseId),
    prerendererConfigPath,
    prerendererOutputPath,
  );
  const dispatcherConfig = await readJson(
    path.resolve(workspaceRoot, options.dispatcherConfigPath),
  );

  validateReleaseTopology({
    apiConfig,
    dispatcherConfig,
    prerendererConfig,
    releaseId,
  });

  await Promise.all([
    writeJson(apiOutputPath, apiConfig),
    writeJson(prerendererOutputPath, prerendererConfig),
  ]);
  return { apiOutputPath, prerendererOutputPath, releaseId };
}

export function prepareGeneratedConfig(config, sourcePath, outputPath) {
  if (typeof config?.main !== "string" || !config.main.trim()) {
    throw new Error("The Worker entry point is missing.");
  }
  const absoluteMain = path.resolve(path.dirname(sourcePath), config.main);
  const relativeMain = path.relative(path.dirname(outputPath), absoluteMain);
  return {
    ...config,
    main: toPortableRelativePath(relativeMain),
  };
}

export function validateReleaseTopology(input) {
  const apiRelease =
    input.apiConfig?.env?.production?.vars?.DOXA_RENDERER_RELEASE_ID;
  const dispatcherRelease =
    input.dispatcherConfig?.vars?.DOXA_RENDERER_RELEASE_ID;
  const prerendererRelease =
    input.prerendererConfig?.vars?.DOXA_RENDERER_RELEASE_ID;
  for (const [name, value] of [
    ["API", apiRelease],
    ["dispatcher", dispatcherRelease],
    ["pre-render Worker", prerendererRelease],
  ]) {
    if (value !== input.releaseId) {
      throw new Error(`${name} does not use the prepared renderer release.`);
    }
  }
  requireServiceBinding(
    input.apiConfig.env.production,
    "PRERENDER_QUEUE",
    "doxa-docs-prerenderer-production",
    "PrerenderQueue",
  );
  requireServiceBinding(
    input.dispatcherConfig,
    "PRERENDER_TASKS",
    "doxa-api-production",
    "PrerenderTaskApi",
  );
  requireServiceBinding(
    input.prerendererConfig,
    "PRERENDER_RENDERER",
    "doxa-docs-renderer",
    "PrerenderRendererApi",
  );
  requireServiceBinding(
    input.prerendererConfig,
    "PRERENDER_TASKS",
    "doxa-api-production",
    "PrerenderTaskApi",
  );
  requireR2Binding(input.dispatcherConfig, "DOCS_RENDERED_BUCKET");
  requireR2Binding(input.prerendererConfig, "DOCS_RENDERED_BUCKET");
  requireWorkflowBinding(input.prerendererConfig);
  if (
    input.prerendererConfig.workers_dev !== false ||
    input.prerendererConfig.preview_urls !== false ||
    input.prerendererConfig.routes?.length
  ) {
    throw new Error("The pre-render Worker must not have a public route.");
  }
}

function withApiRelease(config, releaseId) {
  if (!config?.env?.production) {
    throw new Error("The API production environment is missing.");
  }
  return {
    ...config,
    env: {
      ...config.env,
      production: {
        ...config.env.production,
        vars: {
          ...config.env.production.vars,
          DOXA_RENDERER_RELEASE_ID: releaseId,
        },
      },
    },
  };
}

function withWorkerRelease(config, releaseId) {
  return {
    ...config,
    vars: {
      ...config.vars,
      DOXA_RENDERER_RELEASE_ID: releaseId,
    },
  };
}

function requireServiceBinding(config, binding, service, entrypoint) {
  const match = config?.services?.find(
    (candidate) => candidate?.binding === binding,
  );
  if (match?.service !== service || match?.entrypoint !== entrypoint) {
    throw new Error(
      `${binding} must target ${service}.${entrypoint}.`,
    );
  }
}

function requireR2Binding(config, binding) {
  const match = config?.r2_buckets?.find(
    (candidate) => candidate?.binding === binding,
  );
  if (typeof match?.bucket_name !== "string" || !match.bucket_name.trim()) {
    throw new Error(`${binding} must use a private R2 bucket.`);
  }
}

function requireWorkflowBinding(config) {
  const workflow = config?.workflows?.find(
    (candidate) => candidate?.binding === "PRERENDER_WORKFLOW",
  );
  if (
    workflow?.class_name !== "DocsPrerenderWorkflow" ||
    typeof workflow?.name !== "string" ||
    !workflow.name.trim()
  ) {
    throw new Error("PRERENDER_WORKFLOW is not configured correctly.");
  }
}

function requireReleaseId(value) {
  if (typeof value === "string" && RELEASE_ID_PATTERN.test(value)) {
    return value;
  }
  throw new Error("The renderer package has no valid release ID.");
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function toPortableRelativePath(filePath) {
  const portablePath = filePath.split(path.sep).join("/");
  return portablePath.startsWith(".") ? portablePath : `./${portablePath}`;
}
