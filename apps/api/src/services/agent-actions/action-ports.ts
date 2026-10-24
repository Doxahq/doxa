import type {
  DocsDomainDto,
  DocsPageMdxIssues,
  GenerationDetailDto,
  ProjectDto,
} from "@doxahq/contracts";
import type {
  DocsPublishStage,
  PublishDocsBranchInput,
  PublishDocsBranchResult,
} from "@doxahq/contracts/docs-branches";
import type { DeletedProject } from "../../repositories/project-deletion";
import type { PublicationAttribution } from "../../repositories/docs-publications";
import type { GenerationStartOutcome } from "../generation-start";

/**
 * The narrow services that actions call. `action-services.ts` builds them
 * from the env; tests pass fakes. Only `actions/**` use these.
 */
export interface ProjectScopedInput {
  readonly userId: string;
  readonly projectId: string;
}

export interface PublishBranchState {
  readonly branchId: string;
  readonly branchName: string;
  readonly revision: number;
  readonly baseVersionId: string;
  readonly mainVersionId: string;
  readonly changeCount: number;
}

export interface DocsPublishPort {
  readBranch(input: ProjectScopedInput & { branchId: string }): Promise<PublishBranchState | null>;
  /** The changed pages of the branch that fail the MDX check (spec 8.1). */
  mdxIssues(input: ProjectScopedInput & { branchId: string }): Promise<DocsPageMdxIssues[]>;
  publish(
    input: ProjectScopedInput & {
      branchId: string;
      request: PublishDocsBranchInput;
      attribution: PublicationAttribution;
      onStage?: (stage: DocsPublishStage) => void;
    },
  ): Promise<PublishDocsBranchResult>;
}

export interface LiveSitePort {
  /** The public URL of the live site, or null when it has none. */
  liveUrl(input: ProjectScopedInput): Promise<string | null>;
}

export interface DocsRestorePort {
  mainVersionId(input: ProjectScopedInput): Promise<string | null>;
  restore(
    input: ProjectScopedInput & {
      publicationId: string;
      expectedMainVersionId: string;
      attribution: PublicationAttribution;
    },
  ): Promise<{ publicationId: string; versionId: string }>;
}

export interface DomainSummary {
  readonly id: string;
  readonly hostname: string;
  readonly kind: DocsDomainDto["kind"];
}

export interface DomainsPort {
  find(input: ProjectScopedInput & { domainId: string }): Promise<DomainSummary | null>;
  create(input: ProjectScopedInput & { hostname: string }): Promise<DocsDomainDto>;
  /** Asks Cloudflare for the verification state again. Null when the domain is gone. */
  refresh(input: ProjectScopedInput & { domainId: string }): Promise<DocsDomainDto | null>;
  remove(input: ProjectScopedInput & { domainId: string }): Promise<boolean>;
}

export interface ProjectsPort {
  find(input: ProjectScopedInput): Promise<{ id: string; name: string } | null>;
  createExample(input: { userId: string; name: string; slug?: string }): Promise<ProjectDto>;
  createForRepository(input: {
    userId: string;
    githubRepositoryId: string;
    name?: string;
    slug?: string;
  }): Promise<ProjectDto>;
  delete(input: ProjectScopedInput): Promise<DeletedProject>;
}

export type GenerationCancelOutcome =
  | { readonly outcome: "cancelled"; readonly generation: GenerationDetailDto }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "already_finished" };

export interface GenerationPort {
  hasActiveGeneration(projectId: string): Promise<boolean>;
  start(input: ProjectScopedInput & { force: boolean }): Promise<GenerationStartOutcome>;
  cancel(input: ProjectScopedInput & { generationId: string }): Promise<GenerationCancelOutcome>;
}

export interface ActionServices {
  readonly publish: DocsPublishPort;
  readonly liveSite: LiveSitePort;
  readonly restore: DocsRestorePort;
  readonly domains: DomainsPort;
  readonly projects: ProjectsPort;
  readonly generation: GenerationPort;
}
