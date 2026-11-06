import {
  NO_PROJECT_INSTRUCTIONS_FINGERPRINT,
  exhaustedCatchUpPageIds,
  generationAnalysisStateSchema,
  generationInstructionsFingerprint,
  generationStateManifestSchema,
  instructionCatchUpLedgerKey,
  parseInstructionCatchUpLedger,
} from "@doxahq/contracts";
import { generationStateOwnerVersionId } from "@doxahq/docs-engine";
import type { Env } from "../../env";
import type { ProductionGenerationBaseline } from "../../repositories/production-baselines";
import {
  generationInstructionsSourcesFromEnv,
  loadGenerationInstructions,
  type GenerationInstructionsSources,
} from "./generation-instructions";
import { RepositoryInstructionsUnavailableError } from "./repository-instructions-file";

type PublishedStateLocation = Pick<ProductionGenerationBaseline, "siteId" | "generationStatePrefix">;

/**
 * Whether a run now would use other instructions than the published docs
 * were written with. "unknown" when the published fingerprint or the current
 * repository file cannot be read.
 */
export type InstructionsChange = "changed" | "unchanged" | "unknown";

export interface InstructionsChangeCheck {
  changedSincePublished(input: {
    projectId: string;
    baseline: ProductionGenerationBaseline;
  }): Promise<InstructionsChange>;
}

/** What the published generation state says about its instructions. */
export interface PublishedInstructionsState {
  fingerprint: string;
  /**
   * Pages that the state keeps behind its instructions and a run with the
   * same instructions still writes again: the manifest list without the
   * pages that the site's catch-up ledger says runs stopped trying.
   */
  pagesBehindInstructions: number;
}

export interface InstructionsChangeDependencies {
  sources: GenerationInstructionsSources;
  readPublishedState(baseline: PublishedStateLocation): Promise<PublishedInstructionsState | null>;
}

export function createInstructionsChangeCheck(
  dependencies: InstructionsChangeDependencies,
): InstructionsChangeCheck {
  return {
    async changedSincePublished({ projectId, baseline }) {
      const published = await dependencies.readPublishedState(baseline);
      if (published === null) return "unknown";

      const current = await currentFingerprint(dependencies.sources, projectId);
      if (current === null) return "unknown";
      // A run also has work when a page is still behind the instructions.
      if (current !== published.fingerprint || published.pagesBehindInstructions > 0) return "changed";
      return "unchanged";
    },
  };
}

/** The fingerprint that a run would use now, or null when the repository file cannot be read. */
async function currentFingerprint(
  sources: GenerationInstructionsSources,
  projectId: string,
): Promise<string | null> {
  try {
    return await generationInstructionsFingerprint(await loadGenerationInstructions(sources, projectId));
  } catch (error) {
    if (error instanceof RepositoryInstructionsUnavailableError) return null;
    throw error;
  }
}

export function instructionsChangeCheckFromEnv(env: Env): InstructionsChangeCheck {
  return createInstructionsChangeCheck({
    sources: generationInstructionsSourcesFromEnv(env),
    readPublishedState: (baseline) => readPublishedInstructionsState(env.DOCS_BUCKET, baseline),
  });
}

/**
 * The instructions fingerprint in the generation state of a published
 * version, the value that the run planner compares too, and the pages the
 * state keeps behind it. State from before instructions existed has no
 * fingerprint, which means no instructions. Null when the state cannot be
 * read. Two small reads, a third for the catch-up ledger when pages are
 * behind, and no page records.
 */
export async function readPublishedInstructionsState(
  bucket: Pick<R2Bucket, "get">,
  location: PublishedStateLocation,
): Promise<PublishedInstructionsState | null> {
  const versionId = generationStateOwnerVersionId(location.siteId, location.generationStatePrefix);
  if (versionId === null) return null;

  try {
    const manifest = generationStateManifestSchema.safeParse(
      await readJson(bucket, `${location.generationStatePrefix}/manifest.json`),
    );
    if (!manifest.success || manifest.data.siteId !== location.siteId || manifest.data.versionId !== versionId) {
      return null;
    }

    const analysis = generationAnalysisStateSchema.safeParse(await readJson(bucket, manifest.data.analysis.key));
    if (!analysis.success) return null;
    const fingerprint = analysis.data.projectInstructionsFingerprint ?? NO_PROJECT_INSTRUCTIONS_FINGERPRINT;
    return {
      fingerprint,
      pagesBehindInstructions: await countPagesStillBehind(
        bucket,
        location.siteId,
        manifest.data.behindInstructionPageIds ?? [],
        fingerprint,
      ),
    };
  } catch {
    // The check only decides whether a start asks first, so a read failure
    // must not stop the start.
    return null;
  }
}

/**
 * The behind pages that a run would still try. Read only when some are
 * listed, so most checks keep their two reads. An unreadable ledger is
 * empty: every listed page counts, as the planner would see it.
 */
async function countPagesStillBehind(
  bucket: Pick<R2Bucket, "get">,
  siteId: string,
  behindPageIds: readonly string[],
  fingerprint: string,
): Promise<number> {
  if (behindPageIds.length === 0) return 0;
  const ledger = await readJson(bucket, instructionCatchUpLedgerKey(siteId))
    .then(parseInstructionCatchUpLedger)
    .catch(() => null);
  const exhausted = exhaustedCatchUpPageIds(ledger, fingerprint);
  return behindPageIds.filter((pageId) => !exhausted.has(pageId)).length;
}

async function readJson(bucket: Pick<R2Bucket, "get">, key: string): Promise<unknown> {
  const object = await bucket.get(key);
  return object ? JSON.parse(await object.text()) : null;
}
