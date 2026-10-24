import type {
  GenerationActionsDto,
  GenerationAuthorDto,
  GenerationDeploymentDto,
  GenerationDeploymentState,
  GenerationDetailDto,
  GenerationDomainDto,
  GenerationJobDto,
  GenerationJobTrigger,
  GenerationRerunLinksDto,
  GenerationSourceDto,
} from "@doxahq/contracts";
import type { FlaggedPage } from "@doxahq/contracts/generation-reviews";
import type { ReferenceSourceReport, WorkflowStepFailure } from "@doxahq/contracts";

export interface RecordedStepFailure {
  failure: WorkflowStepFailure;
  failedAt: Date;
}
import { RERUN_EVENT_TYPES } from "./job-events";
import {
  awaitsGenerationReview,
  promoteRetentionFacts,
  resolveGenerationActions,
  type GenerationActionFacts,
  type GenerationRunReview,
  type VersionRetentionState,
} from "../services/generation-actions";
import { resolveRetentionPolicy } from "../services/retention-policy";
import type { DocsUrlEnv } from "../utils/docs-url";
import {
  createDocsHostnameUrl,
  createDocsUrl,
  createGenerationPreviewHostname,
} from "../utils/docs-url";
import {
  createGitHubBranchUrl,
  createGitHubCommitUrl,
  createGitHubPullRequestUrl,
  createGitHubRepositoryUrl,
} from "../utils/github-urls";

interface GenerationUserRow {
  name: string;
  githubLogin: string | null;
  image: string | null;
}

interface GenerationSourceAuthorRow {
  externalId: string;
  handle: string;
  avatarUrl: string | null;
}

interface ChangeProposalRow {
  displayNumber: number;
  state: "open" | "closed" | "merged";
}

interface ProductionDomainRow {
  hostname: string;
  kind: "doxa_subdomain" | "custom_domain";
  status: "active" | "disabled";
  verificationStatus: "pending" | "verified" | "failed";
}

interface PreviewChannelRow {
  hostname: string;
  currentVersionId: string | null;
}

interface GenerationVersionIdentity {
  id: string;
  artifactPrefix: string;
}

interface PublishedVersionIdentity extends GenerationVersionIdentity {
  baselineVersionId: string | null;
}

export function isGenerationServingProduction(input: {
  generationVersion: GenerationVersionIdentity | null;
  publishedVersion: PublishedVersionIdentity | null;
  /** The version that publishing the run's review made, when it did. */
  reviewedVersionId?: string | null;
}): boolean {
  if (!input.generationVersion || !input.publishedVersion) return false;
  if (input.publishedVersion.id === input.generationVersion.id) return true;
  // A reviewed run goes live as the version that its review published.
  if (input.reviewedVersionId && input.publishedVersion.id === input.reviewedVersionId) {
    return true;
  }
  return (
    input.publishedVersion.baselineVersionId ===
      input.generationVersion.id &&
    input.publishedVersion.artifactPrefix ===
      input.generationVersion.artifactPrefix
  );
}

const DOXABOT_AUTHOR: GenerationAuthorDto = {
  kind: "automation",
  displayName: "Doxabot",
  githubLogin: null,
  avatarUrl: null,
};

export function resolveAuthor(input: {
  trigger: GenerationJobTrigger;
  user: GenerationUserRow | null;
  sourceAuthor: GenerationSourceAuthorRow | null;
}): GenerationAuthorDto {
  // Doxabot starts a run after merges on the owner's behalf.
  if (input.trigger === "merge") return DOXABOT_AUTHOR;
  if (input.trigger === "doxabot") {
    if (input.user) {
      const githubLogin =
        input.user.githubLogin ?? input.sourceAuthor?.handle ?? null;
      return {
        kind: "user",
        displayName: githubLogin ?? input.user.name,
        githubLogin,
        avatarUrl: input.user.image ?? input.sourceAuthor?.avatarUrl ?? null,
      };
    }
    if (input.sourceAuthor) {
      return {
        kind: "user",
        displayName: input.sourceAuthor.handle,
        githubLogin: input.sourceAuthor.handle,
        avatarUrl: input.sourceAuthor.avatarUrl,
      };
    }
    return DOXABOT_AUTHOR;
  }
  if (!input.user) {
    return {
      kind: "user",
      displayName: "Unknown",
      githubLogin: null,
      avatarUrl: null,
    };
  }
  return {
    kind: "user",
    displayName: input.user.githubLogin ?? input.user.name,
    githubLogin: input.user.githubLogin,
    avatarUrl: input.user.image,
  };
}

/**
 * The provider that the source links go to. A project repository is a
 * GitHub repository, so a run that a person started links to GitHub too,
 * not only a run that a webhook started.
 */
export function resolveSourceProvider(
  sourceProvider: "github" | null,
  repository: { fullName: string } | null,
): "github" | null {
  return sourceProvider ?? (repository ? "github" : null);
}

export function resolveSource(input: {
  provider: "github" | null;
  repositoryFullName: string | null;
  defaultBranch: string | null;
  publicationMode: "production" | "preview";
  targetRevision: string | null;
  changeProposal: ChangeProposalRow | null;
}): GenerationSourceDto {
  const githubRepositoryFullName =
    input.provider === "github" ? input.repositoryFullName : null;
  const repositoryUrl = githubRepositoryFullName
    ? createGitHubRepositoryUrl(githubRepositoryFullName)
    : null;
  const commit = input.targetRevision
    ? {
        revision: input.targetRevision,
        shortRevision: input.targetRevision.slice(0, 7),
        url: githubRepositoryFullName
          ? createGitHubCommitUrl(
              githubRepositoryFullName,
              input.targetRevision,
            )
          : null,
        message: null,
      }
    : null;
  const changeProposal = input.changeProposal
    ? {
        number: input.changeProposal.displayNumber,
        state: input.changeProposal.state,
        url: githubRepositoryFullName
          ? createGitHubPullRequestUrl(
              githubRepositoryFullName,
              input.changeProposal.displayNumber,
            )
          : null,
      }
    : null;

  const branch =
    input.publicationMode === "production" ? input.defaultBranch : null;

  return {
    provider: input.provider,
    repositoryFullName: input.repositoryFullName,
    repositoryUrl,
    branch,
    branchUrl:
      githubRepositoryFullName && branch
        ? createGitHubBranchUrl(githubRepositoryFullName, branch)
        : null,
    commit,
    changeProposal,
  };
}

/** What a run's version went through, beyond whether it is live now. */
export interface DeploymentHistoryFacts {
  /** True while the run waits in its open generation review. */
  awaitsReview?: boolean;
  /** True when the version went live once, as itself or through its review. */
  wentLive?: boolean;
}

export function resolveDeployment(
  input: {
    publicationMode: "production" | "preview";
    docsVersionId: string | null;
    versionNumber: number | null;
    site: { publishedVersionId: string | null } | null;
    projectSlug?: string;
    productionDomains: ProductionDomainRow[];
    previewChannel: PreviewChannelRow | null;
    isServingProduction?: boolean;
    env: DocsUrlEnv;
  } & DeploymentHistoryFacts,
): GenerationDeploymentDto {
  const deployment =
    input.publicationMode === "preview"
      ? resolvePreviewDeployment(input)
      : resolveProductionDeployment(input);
  return { ...deployment, state: resolveDeploymentState(deployment.isCurrent, input) };
}

/** The state of a run's version: live, in review, replaced, or never published. */
export function resolveDeploymentState(
  isCurrent: boolean,
  history: DeploymentHistoryFacts,
): GenerationDeploymentState {
  if (isCurrent) return "live";
  if (history.awaitsReview) return "in_review";
  if (history.wentLive) return "replaced";
  return "not_published";
}

/**
 * True when a run's version went live once. A production version is marked
 * published when it goes live, and a reviewed run goes live as the version
 * that its review published. A preview run goes live on its pull request
 * preview when it succeeds.
 */
export function didGenerationGoLive(input: {
  publicationMode: "production" | "preview";
  status: GenerationJobDto["status"];
  docsVersionId: string | null;
  versionStatus: "staged" | "published" | "failed" | null;
  review: GenerationRunReview | null;
}): boolean {
  if (input.publicationMode === "preview") {
    return input.status === "succeeded" && input.docsVersionId !== null;
  }
  return input.versionStatus === "published" || Boolean(input.review?.publishedVersionId);
}

/** A re-run event of a run, with the run at its other end. */
export interface RerunEventRow {
  type: string;
  linkedJobId: string;
}

/** Reads the links from the run's re-run events, newest first. */
export function resolveRerunLinks(
  events: RerunEventRow[],
): GenerationRerunLinksDto {
  const linkedJobOf = (type: string) =>
    events.find((event) => event.type === type)?.linkedJobId ?? null;
  return {
    rerunOfId: linkedJobOf(RERUN_EVENT_TYPES.of),
    rerunId: linkedJobOf(RERUN_EVENT_TYPES.started),
  };
}

export function resolveActions(
  input: GenerationActionFacts,
): GenerationActionsDto {
  return resolveGenerationActions(input);
}

type DeploymentWithoutState = Omit<GenerationDeploymentDto, "state">;

function resolveProductionDeployment(input: {
  docsVersionId: string | null;
  versionNumber: number | null;
  site: { publishedVersionId: string | null } | null;
  projectSlug?: string;
  productionDomains: ProductionDomainRow[];
  isServingProduction?: boolean;
  env: DocsUrlEnv;
}): DeploymentWithoutState {
  const customDomains: GenerationDomainDto[] = input.productionDomains
    .filter(
      (domain) =>
        domain.kind === "custom_domain" &&
        domain.status === "active" &&
        domain.verificationStatus === "verified",
    )
    .map((domain) => ({
      hostname: domain.hostname,
      url: createDocsHostnameUrl(domain.hostname, input.env),
      role: "production",
    }));
  const generatedUrl = input.site && input.projectSlug
    ? createDocsUrl(input.projectSlug, input.env)
    : null;
  const generatedDomain = generatedUrl
    ? toGeneratedDomain(generatedUrl)
    : null;
  const productionDomains = generatedDomain
    ? [...customDomains, generatedDomain]
    : customDomains;
  const permanentDomain = toPermanentDomain({
    projectSlug: input.projectSlug ?? null,
    docsVersionId: input.docsVersionId,
    env: input.env,
  });
  const domains = permanentDomain
    ? [...productionDomains, permanentDomain]
    : productionDomains;
  const isCurrent =
    input.isServingProduction === true ||
    (input.docsVersionId !== null &&
      input.site?.publishedVersionId === input.docsVersionId);

  return {
    environment: "production",
    isCurrent,
    docsVersionId: input.docsVersionId,
    versionNumber: input.versionNumber,
    visitUrl:
      (isCurrent ? domains[0]?.url ?? null : null) ??
      permanentDomain?.url ??
      null,
    domains,
  };
}

function resolvePreviewDeployment(input: {
  docsVersionId: string | null;
  versionNumber: number | null;
  projectSlug?: string;
  previewChannel: PreviewChannelRow | null;
  env: DocsUrlEnv;
}): DeploymentWithoutState {
  const domain = input.previewChannel
    ? {
        hostname: input.previewChannel.hostname,
        url: createDocsHostnameUrl(
          input.previewChannel.hostname,
          input.env,
        ),
        role: "preview" as const,
      }
    : null;
  const isCurrent =
    input.docsVersionId !== null &&
    input.previewChannel?.currentVersionId === input.docsVersionId;
  const permanentDomain = toPermanentDomain({
    projectSlug: input.projectSlug ?? null,
    docsVersionId: input.docsVersionId,
    env: input.env,
  });
  const domains = [domain, permanentDomain].filter(
    (candidate): candidate is GenerationDomainDto => candidate !== null,
  );
  return {
    environment: "preview",
    isCurrent,
    docsVersionId: input.docsVersionId,
    versionNumber: input.versionNumber,
    visitUrl:
      (isCurrent ? domain?.url ?? null : null) ??
      permanentDomain?.url ??
      null,
    domains,
  };
}

function toPermanentDomain(input: {
  projectSlug: string | null;
  docsVersionId: string | null;
  env: DocsUrlEnv;
}): GenerationDomainDto | null {
  if (!input.projectSlug || !input.docsVersionId) return null;

  const hostname = createGenerationPreviewHostname(
    {
      projectSlug: input.projectSlug,
      docsVersionId: input.docsVersionId,
    },
    input.env.DOCS_BASE_DOMAIN,
  );
  if (!hostname) return null;

  return {
    hostname,
    url: createDocsHostnameUrl(hostname, input.env),
    role: "permanent",
  };
}

function toGeneratedDomain(url: string): GenerationDomainDto {
  return {
    hostname: new URL(url).hostname,
    url,
    role: "generated",
  };
}

export function toBaseGenerationDto(input: {
  id: string;
  projectId: string;
  status: GenerationJobDto["status"];
  docsVersionId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GenerationJobDto {
  return {
    id: input.id,
    projectId: input.projectId,
    status: input.status,
    docsVersionId: input.docsVersionId,
    errorMessage: input.errorMessage,
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.updatedAt.toISOString(),
  };
}

export interface GenerationDetailAssemblerInput {
  job: {
    id: string;
    projectId: string;
    status: GenerationJobDto["status"];
    trigger: GenerationJobTrigger;
    publicationMode: "production" | "preview";
    docsVersionId: string | null;
    sourceProvider: "github" | null;
    sourceAuthorExternalId: string | null;
    sourceAuthorHandle: string | null;
    sourceAuthorAvatarUrl: string | null;
    targetRevision: string | null;
    errorMessage: string | null;
    /** The run that replaced this preview run, when a newer one did. */
    supersededByJobId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  projectSlug: string;
  user: GenerationUserRow | null;
  repository: {
    fullName: string;
    defaultBranch: string;
  } | null;
  changeProposal: ChangeProposalRow | null;
  site: {
    publishedVersionId: string | null;
  } | null;
  version: {
    id: string;
    versionNumber: number;
    artifactPrefix: string;
    status: "staged" | "published" | "failed";
    /** The fields that decide whether Promote can still use the version. */
    retention?: VersionRetentionState;
  } | null;
  publishedVersion: PublishedVersionIdentity | null;
  review: GenerationRunReview | null;
  productionDomains: ProductionDomainRow[];
  previewChannel: PreviewChannelRow | null;
  /** Newest first, and only the events whose other run still exists. */
  rerunEvents: RerunEventRow[];
  flaggedPages: FlaggedPage[];
  /** The REST reference report of the analysis; null before the analysis ends. */
  referenceSource?: ReferenceSourceReport | null;
  /** The step that ended a failed run, which a resume starts from. */
  stepFailure?: RecordedStepFailure | null;
  /** The time that the retention policy compares against. */
  now?: Date;
  env: DocsUrlEnv;
}

export function toGenerationDetailDto(
  input: GenerationDetailAssemblerInput,
): GenerationDetailDto {
  const isServingProduction = isGenerationServingProduction({
    generationVersion: input.version,
    publishedVersion: input.publishedVersion,
    reviewedVersionId: input.review?.publishedVersionId ?? null,
  });
  const isServingPreview =
    input.job.docsVersionId !== null &&
    input.previewChannel?.currentVersionId === input.job.docsVersionId;
  const awaitsReview = awaitsGenerationReview({
    publicationMode: input.job.publicationMode,
    versionStatus: input.version?.status ?? null,
    review: input.review,
  });

  return {
    ...toBaseGenerationDto(input.job),
    trigger: input.job.trigger,
    author: resolveAuthor({
      trigger: input.job.trigger,
      user: input.user,
      sourceAuthor:
        input.job.sourceAuthorExternalId &&
        input.job.sourceAuthorHandle
          ? {
              externalId: input.job.sourceAuthorExternalId,
              handle: input.job.sourceAuthorHandle,
              avatarUrl: input.job.sourceAuthorAvatarUrl,
            }
          : null,
    }),
    source: resolveSource({
      provider: resolveSourceProvider(input.job.sourceProvider, input.repository),
      repositoryFullName: input.repository?.fullName ?? null,
      defaultBranch: input.repository?.defaultBranch ?? null,
      publicationMode: input.job.publicationMode,
      targetRevision: input.job.targetRevision,
      changeProposal: input.changeProposal,
    }),
    deployment: resolveDeployment({
      publicationMode: input.job.publicationMode,
      docsVersionId: input.job.docsVersionId,
      versionNumber: input.version?.versionNumber ?? null,
      site: input.site,
      projectSlug: input.projectSlug,
      productionDomains: input.productionDomains,
      previewChannel: input.previewChannel,
      isServingProduction,
      awaitsReview,
      wentLive: didGenerationGoLive({
        publicationMode: input.job.publicationMode,
        status: input.job.status,
        docsVersionId: input.job.docsVersionId,
        versionStatus: input.version?.status ?? null,
        review: input.review,
      }),
      env: input.env,
    }),
    actions: resolveActions({
      status: input.job.status,
      docsVersionId: input.job.docsVersionId,
      publishedVersionId: input.site?.publishedVersionId ?? null,
      isServingProduction,
      isServingPreview,
      awaitsReview,
      publicationMode: input.job.publicationMode,
      isSuperseded: input.job.supersededByJobId !== null,
      changeState: input.changeProposal?.state ?? null,
      ...promoteRetentionFacts(
        input.version?.retention ?? null,
        resolveRetentionPolicy({ id: input.job.projectId }),
        input.now ?? new Date(),
      ),
      failedStep: input.stepFailure?.failure ?? null,
      failedAt: input.stepFailure?.failedAt ?? null,
      now: input.now ?? new Date(),
    }),
    rerunLinks: resolveRerunLinks(input.rerunEvents),
    flaggedPages: input.flaggedPages,
    referenceSource: input.referenceSource ?? null,
  };
}
