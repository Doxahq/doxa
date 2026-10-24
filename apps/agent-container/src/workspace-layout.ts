import { isAbsolute, join } from "node:path";

const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function resolveHostedWorkspaceBaseDir(): string {
  const configuredBaseDir = process.env.DOXA_WORKSPACE_ROOT?.trim();
  if (!configuredBaseDir) return process.cwd();
  if (!isAbsolute(configuredBaseDir)) {
    throw new Error("DOXA_WORKSPACE_ROOT must be an absolute path.");
  }
  return configuredBaseDir;
}

export interface HostedWorkspaceLayout {
  jobRoot: string;
  stageRoot: string;
  snapshotRoot: string;
  checkoutRoot: string;
  artifactRoot: string;
  outputDir: string;
  outputRoot: string;
}

export function createHostedWorkspaceLayout(
  baseDir: string,
  workspaceId: string,
  stageId?: string,
): HostedWorkspaceLayout {
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
    throw new Error("Invalid hosted workspace identifier.");
  }
  if (stageId !== undefined && !SAFE_WORKSPACE_ID.test(stageId)) {
    throw new Error("Invalid hosted stage identifier.");
  }

  const jobRoot = join(baseDir, ".workspaces", workspaceId);
  const stageRoot = stageId
    ? join(jobRoot, "stages", stageId)
    : jobRoot;
  const snapshotRoot = stageId ? join(jobRoot, "source") : jobRoot;
  const checkoutRoot = stageId
    ? join(snapshotRoot, "checkout")
    : join(jobRoot, "checkout");
  const artifactRoot = join(stageRoot, "artifacts");
  const outputDir = "docs";

  return {
    jobRoot,
    stageRoot,
    snapshotRoot,
    checkoutRoot,
    artifactRoot,
    outputDir,
    outputRoot: join(artifactRoot, outputDir),
  };
}
