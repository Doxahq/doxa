import {
  isDocumentationStructure,
  templateRenderedPageIds,
} from "@doxahq/agent/structure";
import { MAX_TEMPLATE_WRITE_GROUP_PAGES } from "@doxahq/contracts";
import {
  planPageBatches,
  type WritingStageBudgetInput,
} from "@doxahq/generation";

/**
 * A model group holds pages that the writer model writes. A template group
 * holds pages that a template renders with no model call.
 */
export type WriteGroupKind = "model" | "template";

export interface WriteGroup {
  kind: WriteGroupKind;
  pageIds: string[];
}

export type WriteGroupTimeouts = Record<WriteGroupKind, number>;

/** Template pages of one write group, one Workflow step each. */
export const TEMPLATE_WRITE_GROUP_SIZE = MAX_TEMPLATE_WRITE_GROUP_PAGES;

/** A template group makes no model call, so its step ends far sooner than a model group. */
export const DEFAULT_TEMPLATE_PAGE_BATCH_TIMEOUT_MS = 10 * 60_000;

export interface WriteGroupPlanInput {
  pageIds: readonly string[];
  templatePageIds: readonly string[];
  /** Pages of one model group. */
  modelGroupSize: number;
}

/**
 * Splits the pages of a write stage into template groups and model groups.
 * Template groups come first: they are fast and use no writer slot. Each kind
 * keeps the order of `pageIds`.
 */
export function planWriteGroups(input: WriteGroupPlanInput): WriteGroup[] {
  const templatePages = new Set(input.templatePageIds);
  return [
    ...groupsOf(
      "template",
      input.pageIds.filter((pageId) => templatePages.has(pageId)),
      TEMPLATE_WRITE_GROUP_SIZE,
    ),
    ...groupsOf(
      "model",
      input.pageIds.filter((pageId) => !templatePages.has(pageId)),
      input.modelGroupSize,
    ),
  ];
}

/** The time budget of planned write groups, for the feasibility check. */
export function writingBudgetOf(
  groups: readonly WriteGroup[],
  options: {
    modelGroupSize: number;
    timeouts: WriteGroupTimeouts;
    batchParallelism: number;
  },
): WritingStageBudgetInput {
  return {
    pageCount: pageCountOf(groups, "model"),
    pagesPerBatch: options.modelGroupSize,
    pageBatchTimeoutMs: options.timeouts.model,
    batchParallelism: options.batchParallelism,
    templatePages: {
      pageCount: pageCountOf(groups, "template"),
      pagesPerBatch: TEMPLATE_WRITE_GROUP_SIZE,
      pageBatchTimeoutMs: options.timeouts.template,
    },
  };
}

/** "page" or "template page", for the name of a write step. */
export function writeGroupNoun(group: WriteGroup): string {
  return group.kind === "template" ? "template page" : "page";
}

/**
 * The template-rendered pages of a structure checkpoint. An unreadable
 * checkpoint lists none, so every page goes to a model group as before.
 */
export function templatePageIdsOf(structureCheckpoint: string): string[] {
  const structure = parseJson(structureCheckpoint);
  return isDocumentationStructure(structure) ? templateRenderedPageIds(structure) : [];
}

function groupsOf(kind: WriteGroupKind, pageIds: readonly string[], size: number): WriteGroup[] {
  return planPageBatches(pageIds, size).map((group) => ({ kind, pageIds: group }));
}

function pageCountOf(groups: readonly WriteGroup[], kind: WriteGroupKind): number {
  return groups.reduce(
    (total, group) => total + (group.kind === kind ? group.pageIds.length : 0),
    0,
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
