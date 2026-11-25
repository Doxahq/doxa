import { and, eq, ne, sql } from "drizzle-orm";
import { createDb, schema } from "@doxahq/db";
import { readDocsSearchTarget } from "../services/docs-search/site-provider";
import type {
  CompleteJobOutputInput,
  CompleteJobOutputResult,
  DocsDomainResolution,
  DocsHostResolution,
} from "@doxahq/contracts";
import type { Env } from "../env";
import { isDocsPreviewGateEnabled } from "../env";
import { resolveDocsAccessPolicy } from "../services/docs-access";
import {
  createDocsNamespaceLookup,
  isHostnameAvailable,
} from "../services/docs-namespace";
import {
  compareAndSetPreviewVersion,
  createPreviewHostnameCandidates,
  ensurePreviewChannelWithCandidates,
} from "./preview-channels";
import {
  createDocsHostnameUrl,
  type GenerationPreviewSubdomain,
} from "../utils/docs-url";
import { appendJobEvent } from "./job-events";
import { withDocsPublicationEffects } from "./docs-cache-mutation";
import { recordPublication } from "./docs-publications";
import { nextDocsVersionNumber } from "./docs-version-numbers";
import { retireReplacedPreview } from "./docs-version-retirement";

export type DocsRepositoryEnv = Pick<
  Env,
  | "DATABASE_URL"
  | "HYPERDRIVE"
  | "HYPERDRIVE_CACHE_DISABLED"
  | "DOCS_PREVIEW_GATE_ENABLED"
  | "DOCS_CACHE_INVALIDATOR"
  | "DOCS_BASE_DOMAIN"
  | "DOXA_RENDERER_RELEASE_ID"
  | "PRERENDER_QUEUE"
>;

export class DocsRepository {
  private readonly db;
  private readonly previewGateEnabled: boolean;

  constructor(private readonly env: DocsRepositoryEnv) {
    this.db = createDb(env);
    this.previewGateEnabled = isDocsPreviewGateEnabled(
      env.DOCS_PREVIEW_GATE_ENABLED,
    );
  }

  async resolveBySlug(projectSlug: string): Promise<DocsHostResolution | null> {
    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsSites.publishedVersionId,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        searchProvider: schema.docsSites.searchProvider,
        searchIndexKey: schema.docsSites.searchIndexKey,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
      )
      .where(eq(schema.docsSites.slug, projectSlug))
      .limit(1);

    if (!row?.publishedVersionId) return null;
    return {
      siteId: row.siteId,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      publishedVersionId: row.publishedVersionId,
      artifactPrefix: row.artifactPrefix,
      manifestPath: row.manifestPath,
      accessPolicy: resolveDocsAccessPolicy({
        isGenerationPreview: false,
        previewVisibility: "private",
        gateEnabled: this.previewGateEnabled,
      }),
      ...readDocsSearchTarget(row),
    };
  }

  /**
   * True while the site of the project holds nothing but starter content:
   * no generation, editor, or import publication yet. A first generation may
   * then fill the site branding.
   */
  async holdsOnlyStarterContent(projectId: string): Promise<boolean> {
    const [publication] = await this.db
      .select({ id: schema.docsPublications.id })
      .from(schema.docsPublications)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsPublications.siteId, schema.docsSites.id),
      )
      .where(
        and(
          eq(schema.docsSites.projectId, projectId),
          ne(schema.docsPublications.kind, "starter"),
        ),
      )
      .limit(1);
    return !publication;
  }

  async resolveByProjectId(
    projectId: string,
  ): Promise<DocsHostResolution | null> {
    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        publishedVersionId: schema.docsSites.publishedVersionId,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        searchProvider: schema.docsSites.searchProvider,
        searchIndexKey: schema.docsSites.searchIndexKey,
      })
      .from(schema.docsSites)
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsSites.publishedVersionId, schema.docsVersions.id),
      )
      .where(eq(schema.docsSites.projectId, projectId))
      .limit(1);

    if (!row?.publishedVersionId) return null;
    return {
      siteId: row.siteId,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      publishedVersionId: row.publishedVersionId,
      artifactPrefix: row.artifactPrefix,
      manifestPath: row.manifestPath,
      accessPolicy: resolveDocsAccessPolicy({
        isGenerationPreview: false,
        previewVisibility: "private",
        gateEnabled: this.previewGateEnabled,
      }),
      ...readDocsSearchTarget(row),
    };
  }

  async resolveGenerationPreview(
    preview: GenerationPreviewSubdomain,
  ): Promise<DocsDomainResolution | null> {
    const rows = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.docsSites.projectId,
        projectSlug: schema.docsSites.slug,
        previewVisibility: schema.docsSites.previewVisibility,
        versionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
      })
      .from(schema.docsVersions)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsVersions.siteId, schema.docsSites.id),
      )
      .where(
        and(
          eq(schema.docsSites.slug, preview.projectSlug),
          sql`replace(${schema.docsVersions.id}::text, '-', '') LIKE ${`${preview.versionIdPrefix}%`}`,
        ),
      )
      .limit(2);

    if (rows.length !== 1) return null;
    const [row] = rows;
    if (!row) return null;

    return {
      siteId: row.siteId,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      publishedVersionId: row.versionId,
      artifactPrefix: row.artifactPrefix,
      manifestPath: row.manifestPath,
      accessPolicy: resolveDocsAccessPolicy({
        isGenerationPreview: true,
        previewVisibility: row.previewVisibility,
        gateEnabled: this.previewGateEnabled,
      }),
      hostname: preview.hostname,
      domainKind: "doxa_subdomain",
    };
  }

  async publishJob(input: {
    jobId: string;
    artifactPrefix: string;
    manifestPath: string;
    reason?: "generation" | "starter_publication";
  }) {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [job] = await tx
          .select()
          .from(schema.generationJobs)
          .where(eq(schema.generationJobs.id, input.jobId))
          .for("update")
          .limit(1);

        if (!job) throw new Error("Generation job not found.");
        if (job.status !== "queued" && job.status !== "running") {
          throw new Error("Generation job is no longer active.");
        }
        if (job.publicationMode !== "production") {
          throw new Error(
            "Preview generation jobs cannot publish production documentation.",
          );
        }

        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.projectId, job.projectId))
          .for("update")
          .limit(1);

        if (!site) throw new Error("Docs site not found.");

        const [version] = await tx
          .insert(schema.docsVersions)
          .values({
            siteId: site.id,
            versionNumber: await nextDocsVersionNumber(tx, {
              siteId: site.id,
              channel: "production",
            }),
            status: "published",
            channel: "production",
            artifactPrefix: input.artifactPrefix,
            manifestPath: input.manifestPath,
            sourceRevision: job.targetRevision,
            sourceTreeHash: job.sourceTreeHash,
            baselineVersionId: job.baselineVersionId,
            generatorFingerprint: job.generatorFingerprint,
            generationStatePrefix: `${input.artifactPrefix}/generation-state`,
          })
          .returning();

        await tx
          .update(schema.docsSites)
          .set({ publishedVersionId: version.id, updatedAt: new Date() })
          .where(eq(schema.docsSites.id, site.id));
        await recordPublication(tx, {
          siteId: site.id,
          versionId: version.id,
          previousVersionId: site.publishedVersionId,
          kind:
            input.reason === "starter_publication" ? "starter" : "generation",
          actorUserId: null,
          branchName: null,
          summary: {},
        });
        await enqueue({ siteId: site.id });
        await enqueuePrerender({
          siteId: site.id,
          publishedVersionId: version.id,
          reason: input.reason ?? "generation",
        });

        await tx
          .update(schema.generationJobs)
          .set({
            status: "succeeded",
            docsVersionId: version.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.generationJobs.id, input.jobId));

        await appendJobEvent(tx, {
          jobId: input.jobId,
          type: "published",
          message: "Docs published.",
          data: { versionId: version.id, outcome: "succeeded", terminal: true },
          source: "worker",
        });

        return version;
      },
    );
  }

  /**
   * Publishes the first version of a site without a generation job, for
   * projects that start from built-in content. The version has no source
   * revision, so it never becomes a generation baseline.
   */
  async publishSeedVersion(input: {
    siteId: string;
    versionId: string;
    artifactPrefix: string;
    manifestPath: string;
  }) {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.id, input.siteId))
          .for("update")
          .limit(1);

        if (!site) throw new Error("Docs site not found.");
        if (site.publishedVersionId) {
          throw new Error("Docs site already has a published version.");
        }

        const [version] = await tx
          .insert(schema.docsVersions)
          .values({
            id: input.versionId,
            siteId: site.id,
            versionNumber: await nextDocsVersionNumber(tx, {
              siteId: site.id,
              channel: "production",
            }),
            status: "published",
            channel: "production",
            artifactPrefix: input.artifactPrefix,
            manifestPath: input.manifestPath,
            generationStatePrefix: `${input.artifactPrefix}/generation-state`,
          })
          .returning();

        await tx
          .update(schema.docsSites)
          .set({ publishedVersionId: version.id, updatedAt: new Date() })
          .where(eq(schema.docsSites.id, site.id));
        await recordPublication(tx, {
          siteId: site.id,
          versionId: version.id,
          previousVersionId: null,
          kind: "starter",
          actorUserId: null,
          branchName: null,
          summary: {},
        });
        await enqueue({ siteId: site.id });
        await enqueuePrerender({
          siteId: site.id,
          publishedVersionId: version.id,
          reason: "starter_publication",
        });

        return version;
      },
    );
  }

  async completeJob(
    jobId: string,
    input: CompleteJobOutputInput,
    env: Pick<Env, "DOCS_BASE_DOMAIN" | "DOCS_RENDERER_BASE_URL">,
  ): Promise<CompleteJobOutputResult> {
    return withDocsPublicationEffects(
      this.db,
      this.env,
      async (tx, enqueue, enqueuePrerender) => {
        const [job] = await tx
          .select()
          .from(schema.generationJobs)
          .where(eq(schema.generationJobs.id, jobId))
          .for("update")
          .limit(1);

        if (!job) {
          throw new Error("Generation job not found.");
        }
        if (job.status === "succeeded") {
          return resolveIdempotentCompletion(tx, job, input, env);
        }
        if (job.status !== "queued" && job.status !== "running") {
          throw new Error("Generation job is no longer active.");
        }

        assertJobCompletionIdentity(job, input);

        const [site] = await tx
          .select()
          .from(schema.docsSites)
          .where(eq(schema.docsSites.projectId, job.projectId))
          .for("update")
          .limit(1);
        if (!site) {
          throw new Error("Docs site not found.");
        }
        assertArtifactIdentity(site.id, input);
        await assertBaselineVersionIdentity(
          tx,
          site.id,
          input.baselineVersionId,
        );

        const placement = await placeCompletion(tx, site, input);
        const channel = placement === "production" ? "production" : "preview";
        const [version] = await tx
          .insert(schema.docsVersions)
          .values({
            id: input.versionId,
            siteId: site.id,
            versionNumber: await nextDocsVersionNumber(tx, {
              siteId: site.id,
              channel,
            }),
            status: placement === "production" ? "published" : "staged",
            channel,
            artifactPrefix: input.artifactPrefix,
            manifestPath: input.manifestPath,
            sourceRevision: input.sourceRevision,
            sourceTreeHash: input.sourceTreeHash,
            baselineVersionId: input.baselineVersionId,
            generatorFingerprint: input.generatorFingerprint,
            generationStatePrefix: input.generationStatePrefix,
          })
          .returning();
        if (!version) {
          throw new Error("Documentation version could not be created.");
        }

        let previewUrl: string | null = null;
        if (input.publicationMode === "preview") {
          const proposal = await getLockedPreviewProposal(
            tx,
            job.changeProposalId,
          );
          assertPreviewProposalIdentity(job, proposal, input);

          const docsNamespace = createDocsNamespaceLookup(tx);
          const hostnameCandidates = await createPreviewHostnameCandidates({
            projectId: job.projectId,
            projectSlug: site.slug,
            provider: input.provider,
            changeExternalId: input.changeExternalId,
            changeNumber: input.changeNumber,
            docsBaseDomain: env.DOCS_BASE_DOMAIN,
            isAvailable: (candidate) =>
              isHostnameAvailable(docsNamespace, candidate),
          });
          const channel = await ensurePreviewChannelWithCandidates(tx, {
            projectId: job.projectId,
            siteId: site.id,
            provider: input.provider,
            changeExternalId: input.changeExternalId,
            hostnameCandidates,
          });
          const advanced = await compareAndSetPreviewVersion(tx, {
            channelId: channel.id,
            expectedVersionId: input.expectedPreviewVersionId,
            versionId: version.id,
          });
          if (!advanced) {
            throw new Error(
              "The documentation preview was superseded before completion.",
            );
          }
          if (
            input.expectedPreviewVersionId &&
            input.expectedPreviewVersionId !== version.id
          ) {
            await retireReplacedPreview(
              tx,
              { siteId: site.id, versionId: input.expectedPreviewVersionId },
              new Date(),
            );
          }
          previewUrl = createDocsHostnameUrl(channel.hostname, env);
        } else if (placement === "production") {
          await tx
            .update(schema.docsSites)
            .set({
              publishedVersionId: version.id,
              updatedAt: new Date(),
            })
            .where(eq(schema.docsSites.id, site.id));
          await recordPublication(tx, {
            siteId: site.id,
            versionId: version.id,
            previousVersionId: site.publishedVersionId,
            kind: "generation",
            actorUserId: null,
            branchName: null,
            summary: {},
          });
          await enqueue({ siteId: site.id });
          await enqueuePrerender({
            siteId: site.id,
            publishedVersionId: version.id,
            reason: "generation",
          });
        }

        await tx
          .update(schema.generationJobs)
          .set({
            status: "succeeded",
            docsVersionId: version.id,
            sourceTreeHash: input.sourceTreeHash,
            updatedAt: new Date(),
          })
          .where(eq(schema.generationJobs.id, jobId));

        await appendJobEvent(tx, {
          jobId,
          ...COMPLETION_EVENTS[placement],
          data: {
            versionId: version.id,
            outcome: "succeeded",
            terminal: true,
            changedSourceCount: input.changedSourceCount,
            regeneratedPageCount: input.regeneratedPageCount,
            reusedPageCount: input.reusedPageCount,
          },
          source: "worker",
        });

        return { versionId: version.id, previewUrl };
      },
    );
  }
}

type DocsTransaction = Parameters<
  Parameters<ReturnType<typeof createDb>["transaction"]>[0]
>[0];

async function resolveIdempotentCompletion(
  tx: DocsTransaction,
  job: typeof schema.generationJobs.$inferSelect,
  input: CompleteJobOutputInput,
  env: Pick<Env, "DOCS_BASE_DOMAIN" | "DOCS_RENDERER_BASE_URL">,
): Promise<CompleteJobOutputResult> {
  if (job.docsVersionId !== input.versionId) {
    throw new Error(
      "Generation job was already completed with a different version.",
    );
  }
  const [version] = await tx
    .select()
    .from(schema.docsVersions)
    .where(eq(schema.docsVersions.id, input.versionId))
    .limit(1);
  if (!version || !completionMatchesVersion(input, version)) {
    throw new Error(
      "Completed documentation version does not match this request.",
    );
  }
  if (input.publicationMode === "publish") {
    return { versionId: version.id, previewUrl: null };
  }

  const [channel] = await tx
    .select({
      hostname: schema.docsPreviewChannels.hostname,
      currentVersionId: schema.docsPreviewChannels.currentVersionId,
    })
    .from(schema.docsPreviewChannels)
    .where(
      and(
        eq(schema.docsPreviewChannels.projectId, job.projectId),
        eq(schema.docsPreviewChannels.siteId, version.siteId),
        eq(schema.docsPreviewChannels.provider, input.provider),
        eq(schema.docsPreviewChannels.changeExternalId, input.changeExternalId),
      ),
    )
    .limit(1);
  if (channel?.currentVersionId !== version.id) {
    throw new Error(
      "Completed preview channel does not reference this version.",
    );
  }
  return {
    versionId: version.id,
    previewUrl: createDocsHostnameUrl(channel.hostname, env),
  };
}

function assertJobCompletionIdentity(
  job: typeof schema.generationJobs.$inferSelect,
  input: CompleteJobOutputInput,
): void {
  const expectedMode =
    input.publicationMode === "preview" ? "preview" : "production";
  if (job.publicationMode !== expectedMode) {
    throw new Error("Generation publication mode does not match the job.");
  }
  if (
    job.targetRevision !== input.sourceRevision ||
    job.baselineVersionId !== input.baselineVersionId ||
    job.generatorFingerprint !== input.generatorFingerprint
  ) {
    throw new Error("Generation completion identity does not match the job.");
  }
  if (
    job.sourceTreeHash !== null &&
    job.sourceTreeHash !== input.sourceTreeHash
  ) {
    throw new Error("Generation source tree does not match the job.");
  }
  if (
    input.publicationMode === "preview" &&
    (job.sourceProvider !== input.provider ||
      job.changeExternalId !== input.changeExternalId ||
      job.targetRevision !== input.expectedHeadRevision)
  ) {
    throw new Error("Generation preview identity does not match the job.");
  }
}

function assertArtifactIdentity(
  siteId: string,
  input: CompleteJobOutputInput,
): void {
  const artifactPrefix = `sites/${siteId}/versions/${input.versionId}`;
  const generationStatePrefix = `sites/${siteId}/generation-state/${input.versionId}`;
  if (
    input.artifactPrefix !== artifactPrefix ||
    input.manifestPath !== `${artifactPrefix}/manifest.json` ||
    input.generationStatePrefix !== generationStatePrefix
  ) {
    throw new Error(
      "Generation artifact paths do not match the requested version.",
    );
  }
}

async function assertBaselineVersionIdentity(
  tx: DocsTransaction,
  siteId: string,
  baselineVersionId: string | null,
): Promise<void> {
  if (baselineVersionId === null) return;
  const [baseline] = await tx
    .select({ siteId: schema.docsVersions.siteId })
    .from(schema.docsVersions)
    .where(eq(schema.docsVersions.id, baselineVersionId))
    .limit(1);
  if (!baseline || baseline.siteId !== siteId) {
    throw new Error(
      "Generation baseline version does not belong to this docs site.",
    );
  }
}

/**
 * Where a finished run goes. A preview run serves its pull request. A
 * production run publishes only when the site holds nothing that a person
 * wrote or approved; otherwise its version waits for a review.
 */
type CompletionPlacement = "preview" | "review" | "production";

const COMPLETION_EVENTS: Record<
  CompletionPlacement,
  { type: string; message: string }
> = {
  preview: {
    type: "preview_published",
    message: "Documentation preview published.",
  },
  review: {
    type: "staged_for_review",
    message: "The generated docs are ready for review.",
  },
  production: { type: "published", message: "Docs published." },
};

async function placeCompletion(
  tx: DocsTransaction,
  site: typeof schema.docsSites.$inferSelect,
  input: CompleteJobOutputInput,
): Promise<CompletionPlacement> {
  if (input.publicationMode === "preview") {
    return "preview";
  }

  return (await holdsReviewedContent(tx, site)) ? "review" : "production";
}

/** True when the published site is more than the built-in starter content. */
async function holdsReviewedContent(
  tx: DocsTransaction,
  site: typeof schema.docsSites.$inferSelect,
): Promise<boolean> {
  if (!site.publishedVersionId) {
    return false;
  }

  const [publication] = await tx
    .select({ id: schema.docsPublications.id })
    .from(schema.docsPublications)
    .where(
      and(
        eq(schema.docsPublications.siteId, site.id),
        ne(schema.docsPublications.kind, "starter"),
      ),
    )
    .limit(1);
  return Boolean(publication);
}

async function getLockedPreviewProposal(
  tx: DocsTransaction,
  proposalId: string | null,
) {
  if (!proposalId) {
    throw new Error("Preview generation job has no change proposal.");
  }
  const [proposal] = await tx
    .select()
    .from(schema.scmChangeProposals)
    .where(eq(schema.scmChangeProposals.id, proposalId))
    .for("update")
    .limit(1);
  if (!proposal) {
    throw new Error("Change proposal not found.");
  }
  return proposal;
}

function assertPreviewProposalIdentity(
  job: typeof schema.generationJobs.$inferSelect,
  proposal: typeof schema.scmChangeProposals.$inferSelect,
  input: Extract<CompleteJobOutputInput, { publicationMode: "preview" }>,
): void {
  if (
    proposal.projectId !== job.projectId ||
    proposal.provider !== input.provider ||
    proposal.externalId !== input.changeExternalId ||
    proposal.displayNumber !== input.changeNumber ||
    proposal.headRevision !== input.expectedHeadRevision ||
    proposal.state !== "open"
  ) {
    throw new Error("The pull request changed before preview completion.");
  }
}

function completionMatchesVersion(
  input: CompleteJobOutputInput,
  version: typeof schema.docsVersions.$inferSelect,
): boolean {
  // A production run that waits for review keeps its version off the
  // published sequence, on the preview channel.
  const channelMatches =
    input.publicationMode === "preview"
      ? version.channel === "preview"
      : version.channel === "production" ||
        (version.channel === "preview" && version.status === "staged");
  return (
    channelMatches &&
    version.artifactPrefix === input.artifactPrefix &&
    version.manifestPath === input.manifestPath &&
    version.sourceRevision === input.sourceRevision &&
    version.sourceTreeHash === input.sourceTreeHash &&
    version.baselineVersionId === input.baselineVersionId &&
    version.generatorFingerprint === input.generatorFingerprint &&
    version.generationStatePrefix === input.generationStatePrefix
  );
}
