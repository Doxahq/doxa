import type { DocsDomainResolution, SourceProvider } from "@doxahq/contracts";
import { createDb, schema, type DbEnv, type DoxaDb } from "@doxahq/db";
import { and, eq, isNull } from "drizzle-orm";
import { isDocsPreviewGateEnabled } from "../env";
import { resolveDocsAccessPolicy } from "../services/docs-access";
import type { DocsNamespaceCandidate } from "../services/docs-namespace";
import { createGeneratedDocsHostname } from "../utils/docs-url";
import { normalizeDocsHostname } from "../utils/hostname";

export type PreviewChannelLifecycleState = "active" | "closed" | "expired";

interface PreviewChannelBase {
  id: string;
  projectId: string;
  siteId: string;
  hostname: string;
  currentVersionId: string | null;
  lifecycleState: PreviewChannelLifecycleState;
  expiresAt: Date | null;
}

export type PreviewChannelRecord = PreviewChannelBase &
  (
    | {
        kind: "source_change";
        provider: SourceProvider;
        changeExternalId: string;
        branchId: null;
      }
    | {
        kind: "branch";
        provider: null;
        changeExternalId: null;
        branchId: string;
      }
  );

export interface EnsurePreviewChannelInput {
  projectId: string;
  siteId: string;
  provider: SourceProvider;
  changeExternalId: string;
  hostname: string;
  expiresAt?: Date | null;
}

export interface PreviewHostnameInput {
  projectId: string;
  projectSlug: string;
  provider: SourceProvider;
  changeExternalId: string;
  changeNumber: number;
  docsBaseDomain: string | undefined;
  isAvailable(candidate: DocsNamespaceCandidate): Promise<boolean>;
  /** Tests pass a fixed value. Otherwise 16 random hex characters. */
  randomSuffix?: string;
}

export interface ChannelHostnameInput {
  stem: string;
  identity: string;
  requiredSuffix?: string;
  docsBaseDomain: string | undefined;
  isAvailable(candidate: DocsNamespaceCandidate): Promise<boolean>;
}

export interface EnsureBranchPreviewChannelInput {
  projectId: string;
  siteId: string;
  branchId: string;
  hostname: string;
}

/**
 * Every preview channel, branch or pull request, follows the generation
 * preview policy (SEC-006, owner decision 2026-10-31): with the preview gate
 * on, a private preview needs sign-in. A pull request preview can show
 * unmerged work of a private repository just like a branch preview.
 */
export function resolvePreviewChannelAccessPolicy(input: {
  previewVisibility: "private" | "public";
  gateEnabled: boolean;
}) {
  return resolveDocsAccessPolicy({
    isGenerationPreview: true,
    previewVisibility: input.previewVisibility,
    gateEnabled: input.gateEnabled,
  });
}

type PreviewChannelTransaction = Parameters<
  Parameters<DoxaDb["transaction"]>[0]
>[0];
export type PreviewChannelDatabase = DoxaDb | PreviewChannelTransaction;

export interface PreviewChannelsStore {
  ensure(input: EnsurePreviewChannelInput): Promise<PreviewChannelRecord>;
  getByIdentity(input: {
    projectId: string;
    siteId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<PreviewChannelRecord | null>;
  compareAndSetVersion(input: {
    channelId: string;
    expectedVersionId: string | null;
    versionId: string;
  }): Promise<boolean>;
  setLifecycle(input: {
    channelId: string;
    lifecycleState: PreviewChannelLifecycleState;
    expiresAt: Date | null;
  }): Promise<void>;
  resolveByHostname(hostname: string): Promise<DocsDomainResolution | null>;
}

export class PreviewChannelsRepository implements PreviewChannelsStore {
  private readonly db;
  private readonly previewGateEnabled: boolean;

  constructor(env: DbEnv & { DOCS_PREVIEW_GATE_ENABLED?: string }) {
    this.db = createDb(env);
    this.previewGateEnabled = isDocsPreviewGateEnabled(
      env.DOCS_PREVIEW_GATE_ENABLED,
    );
  }

  async ensure(
    input: EnsurePreviewChannelInput,
  ): Promise<PreviewChannelRecord> {
    return ensurePreviewChannel(this.db, input);
  }

  async getByIdentity(input: {
    projectId: string;
    siteId: string;
    provider: SourceProvider;
    changeExternalId: string;
  }): Promise<PreviewChannelRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.docsPreviewChannels)
      .where(
        and(
          eq(schema.docsPreviewChannels.projectId, input.projectId),
          eq(schema.docsPreviewChannels.siteId, input.siteId),
          eq(schema.docsPreviewChannels.provider, input.provider),
          eq(
            schema.docsPreviewChannels.changeExternalId,
            input.changeExternalId,
          ),
        ),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  }

  async compareAndSetVersion(input: {
    channelId: string;
    expectedVersionId: string | null;
    versionId: string;
  }): Promise<boolean> {
    return compareAndSetPreviewVersion(this.db, input);
  }

  async setLifecycle(input: {
    channelId: string;
    lifecycleState: PreviewChannelLifecycleState;
    expiresAt: Date | null;
  }): Promise<void> {
    await this.db
      .update(schema.docsPreviewChannels)
      .set({
        lifecycleState: input.lifecycleState,
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.docsPreviewChannels.id, input.channelId));
  }

  async resolveByHostname(
    hostname: string,
  ): Promise<DocsDomainResolution | null> {
    const normalizedHostname = normalizeDocsHostname(hostname);
    if (!normalizedHostname) return null;

    const [row] = await this.db
      .select({
        siteId: schema.docsSites.id,
        projectId: schema.projects.id,
        projectSlug: schema.projects.slug,
        versionId: schema.docsVersions.id,
        artifactPrefix: schema.docsVersions.artifactPrefix,
        manifestPath: schema.docsVersions.manifestPath,
        hostname: schema.docsPreviewChannels.hostname,
        previewKind: schema.docsPreviewChannels.kind,
        previewVisibility: schema.docsSites.previewVisibility,
      })
      .from(schema.docsPreviewChannels)
      .innerJoin(
        schema.docsSites,
        eq(schema.docsPreviewChannels.siteId, schema.docsSites.id),
      )
      .innerJoin(
        schema.projects,
        eq(schema.docsPreviewChannels.projectId, schema.projects.id),
      )
      .innerJoin(
        schema.docsVersions,
        eq(schema.docsPreviewChannels.currentVersionId, schema.docsVersions.id),
      )
      .where(
        and(
          eq(schema.docsPreviewChannels.hostname, normalizedHostname),
          eq(schema.docsPreviewChannels.lifecycleState, "active"),
          eq(schema.docsVersions.channel, "preview"),
        ),
      )
      .limit(1);

    if (!row) return null;
    return {
      siteId: row.siteId,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      publishedVersionId: row.versionId,
      artifactPrefix: row.artifactPrefix,
      manifestPath: row.manifestPath,
      accessPolicy: resolvePreviewChannelAccessPolicy({
        previewVisibility: row.previewVisibility,
        gateEnabled: this.previewGateEnabled,
      }),
      hostname: row.hostname,
      domainKind: "doxa_subdomain",
      // The dispatcher shows the unreviewed pull request banner only for
      // `source_change`.
      previewKind: row.previewKind,
    };
  }
}

export async function ensurePreviewChannel(
  db: PreviewChannelDatabase,
  input: EnsurePreviewChannelInput,
): Promise<PreviewChannelRecord> {
  const [created] = await db
    .insert(schema.docsPreviewChannels)
    .values({
      ...input,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return toRecord(created);

  const existing = await getPreviewChannelByIdentity(db, input);
  if (!existing) {
    throw new PreviewHostnameCollisionError(input.hostname);
  }
  return existing;
}

export async function ensurePreviewChannelWithCandidates(
  db: PreviewChannelDatabase,
  input: Omit<EnsurePreviewChannelInput, "hostname"> & {
    hostnameCandidates: readonly string[];
  },
): Promise<PreviewChannelRecord> {
  const existing = await getPreviewChannelByIdentity(db, input);
  if (existing) return existing;

  for (const hostname of input.hostnameCandidates) {
    try {
      return await ensurePreviewChannel(db, {
        projectId: input.projectId,
        siteId: input.siteId,
        provider: input.provider,
        changeExternalId: input.changeExternalId,
        expiresAt: input.expiresAt,
        hostname,
      });
    } catch (error) {
      if (!(error instanceof PreviewHostnameCollisionError)) {
        throw error;
      }
    }
  }

  throw new Error(
    "A unique documentation preview hostname could not be allocated.",
  );
}

export async function compareAndSetPreviewVersion(
  db: PreviewChannelDatabase,
  input: {
    channelId: string;
    expectedVersionId: string | null;
    versionId: string;
  },
): Promise<boolean> {
  const currentVersionCondition =
    input.expectedVersionId === null
      ? isNull(schema.docsPreviewChannels.currentVersionId)
      : eq(
          schema.docsPreviewChannels.currentVersionId,
          input.expectedVersionId,
        );

  const [updated] = await db
    .update(schema.docsPreviewChannels)
    .set({
      currentVersionId: input.versionId,
      lifecycleState: "active",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.docsPreviewChannels.id, input.channelId),
        currentVersionCondition,
      ),
    )
    .returning({ id: schema.docsPreviewChannels.id });

  return Boolean(updated);
}

export async function createPreviewHostnameCandidates(
  input: PreviewHostnameInput,
): Promise<string[]> {
  // A random suffix, like branch previews: `<slug>-pr-<n>` alone let anyone
  // walk the pull request numbers of a site (SEC-006). The channel keeps the
  // hostname it got first, so a pull request keeps one URL.
  return createChannelHostnameCandidates({
    stem: `${input.projectSlug}-pr-${input.changeNumber}`,
    identity: [input.projectId, input.provider, input.changeExternalId].join(
      ":",
    ),
    requiredSuffix: input.randomSuffix ?? createRandomHex(8),
    docsBaseDomain: input.docsBaseDomain,
    isAvailable: input.isAvailable,
  });
}

/** `byteLength` random bytes as lowercase hex. */
export function createRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function createChannelHostnameCandidates(
  input: ChannelHostnameInput,
): Promise<string[]> {
  const stem = normalizeHostnameLabel(input.stem);
  const digest = await sha256Hex(input.identity);
  const requiredSuffix = input.requiredSuffix
    ? `-${normalizeRequiredSuffix(input.requiredSuffix)}`
    : "";
  const suffixes = [
    requiredSuffix,
    `-${digest.slice(0, 8)}${requiredSuffix}`,
    `-${digest.slice(0, 16)}${requiredSuffix}`,
  ];
  const candidates = suffixes.map((suffix): DocsNamespaceCandidate => {
    const label = fitHostnameLabel(stem, suffix);
    const candidateLabel = `${label}${suffix}`;
    const hostname = createGeneratedDocsHostname(
      candidateLabel,
      input.docsBaseDomain,
    );
    if (!hostname) {
      throw new Error(
        "DOCS_BASE_DOMAIN is required to publish documentation previews.",
      );
    }
    return { label: candidateLabel, hostname };
  });

  const availableHostnames: string[] = [];
  for (const candidate of candidates) {
    if (candidate.hostname && (await input.isAvailable(candidate))) {
      availableHostnames.push(candidate.hostname);
    }
  }

  return [...new Set(availableHostnames)];
}

export async function ensureBranchPreviewChannelWithCandidates(
  db: PreviewChannelDatabase,
  input: Omit<EnsureBranchPreviewChannelInput, "hostname"> & {
    hostnameCandidates: readonly string[];
  },
): Promise<PreviewChannelRecord> {
  const existing = await getBranchPreviewChannel(db, input.branchId);

  if (existing) {
    return existing;
  }

  for (const hostname of input.hostnameCandidates) {
    const [created] = await db
      .insert(schema.docsPreviewChannels)
      .values({
        projectId: input.projectId,
        siteId: input.siteId,
        branchId: input.branchId,
        kind: "branch",
        provider: null,
        changeExternalId: null,
        hostname,
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      return toRecord(created);
    }

    const concurrent = await getBranchPreviewChannel(db, input.branchId);

    if (concurrent) {
      return concurrent;
    }
  }

  throw new Error(
    "A unique documentation preview hostname could not be allocated.",
  );
}

async function getPreviewChannelByIdentity(
  db: PreviewChannelDatabase,
  input: Pick<
    EnsurePreviewChannelInput,
    "projectId" | "siteId" | "provider" | "changeExternalId"
  >,
): Promise<PreviewChannelRecord | null> {
  const [row] = await db
    .select()
    .from(schema.docsPreviewChannels)
    .where(
      and(
        eq(schema.docsPreviewChannels.projectId, input.projectId),
        eq(schema.docsPreviewChannels.siteId, input.siteId),
        eq(schema.docsPreviewChannels.provider, input.provider),
        eq(schema.docsPreviewChannels.changeExternalId, input.changeExternalId),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

function normalizeHostnameLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized) {
    throw new Error("A preview hostname label could not be generated.");
  }
  return normalized;
}

function fitHostnameLabel(stem: string, suffix: string): string {
  const availableLength = 63 - suffix.length;
  const fitted = stem.slice(0, availableLength).replace(/-+$/g, "");
  if (!fitted) {
    throw new Error("A preview hostname label could not be generated.");
  }
  return fitted;
}

function normalizeRequiredSuffix(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error("A preview hostname suffix is invalid.");
  }

  return normalized;
}

async function getBranchPreviewChannel(
  db: PreviewChannelDatabase,
  branchId: string,
): Promise<PreviewChannelRecord | null> {
  const [row] = await db
    .select()
    .from(schema.docsPreviewChannels)
    .where(eq(schema.docsPreviewChannels.branchId, branchId))
    .limit(1);

  return row ? toRecord(row) : null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

class PreviewHostnameCollisionError extends Error {
  constructor(hostname: string) {
    super(`Documentation preview hostname is already in use: ${hostname}`);
    this.name = "PreviewHostnameCollisionError";
  }
}

function toRecord(
  row: typeof schema.docsPreviewChannels.$inferSelect,
): PreviewChannelRecord {
  const base = {
    id: row.id,
    projectId: row.projectId,
    siteId: row.siteId,
    hostname: row.hostname,
    currentVersionId: row.currentVersionId,
    lifecycleState: row.lifecycleState,
    expiresAt: row.expiresAt,
  };
  if (row.kind === "branch") {
    if (!row.branchId || row.provider || row.changeExternalId) {
      throw new Error("Invalid branch preview channel");
    }
    return {
      ...base,
      kind: "branch",
      branchId: row.branchId,
      provider: null,
      changeExternalId: null,
    };
  }
  if (!row.provider || !row.changeExternalId || row.branchId) {
    throw new Error("Invalid source-change preview channel");
  }
  return {
    ...base,
    kind: "source_change",
    branchId: null,
    provider: row.provider,
    changeExternalId: row.changeExternalId,
  };
}
