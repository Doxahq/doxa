/**
 * Lightweight token usage capture for dev/test harnesses.
 *
 * Provider usage is surfaced on individual non-streaming responses. This module
 * lets higher-level workflows aggregate those calls without threading counters
 * through every production API.
 */

import type { TokenUsage } from "./types";

export interface UsageRecord {
  usage: TokenUsage;
  model?: string;
  generationId?: string;
  recordedAt: string;
}

export interface UsageMetadata {
  model?: string;
  generationId?: string;
}

type UsageSink = (record: UsageRecord) => void;

const activeSinks = new Set<UsageSink>();

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: addOptional(a.cachedTokens, b.cachedTokens),
    cacheWriteTokens: addOptional(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: addOptional(a.reasoningTokens, b.reasoningTokens),
    cost: addOptional(a.cost, b.cost),
    promptCost: addOptional(a.promptCost, b.promptCost),
    completionCost: addOptional(a.completionCost, b.completionCost),
    upstreamCost: addOptional(a.upstreamCost, b.upstreamCost),
  };
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function subscribeUsage(sink: UsageSink): () => void {
  activeSinks.add(sink);
  return () => {
    activeSinks.delete(sink);
  };
}

export function recordUsage(usage: TokenUsage | undefined, metadata: UsageMetadata = {}): void {
  if (!usage || activeSinks.size === 0) return;

  const record: UsageRecord = {
    usage,
    model: metadata.model,
    generationId: metadata.generationId,
    recordedAt: new Date().toISOString(),
  };

  for (const sink of activeSinks) {
    sink(record);
  }
}

export async function captureUsage<T>(
  fn: () => Promise<T>
): Promise<{ result: T; usage: TokenUsage }> {
  let total = emptyUsage();

  const unsubscribe = subscribeUsage((record) => {
    total = addUsage(total, record.usage);
  });

  try {
    const result = await fn();
    return { result, usage: total };
  } finally {
    unsubscribe();
  }
}
