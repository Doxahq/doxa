import type { DocsDomainResolution } from "@doxahq/contracts";
import type { DocsWarmMessage } from "@doxahq/contracts/docs-warm-job";

import type { WarmJob } from "../../src/warm/warm-job";
import type { WarmStorage } from "../../src/warm/warm-storage";

export const RELEASE = "c".repeat(64);
export const OTHER_RELEASE = "d".repeat(64);
export const JOB_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
export const THIRD_JOB_ID = "33333333-3333-4333-8333-333333333333";
export const TARGET = "a".repeat(64);
export const OTHER_TARGET = "e".repeat(64);

export function siteResolution(
  overrides: Partial<DocsDomainResolution> = {},
): DocsDomainResolution {
  return {
    siteId: "site-1",
    projectId: "project-1",
    projectSlug: "demo",
    publishedVersionId: "version-2",
    artifactPrefix: "sites/site-1/versions/source-2",
    manifestPath: "sites/site-1/versions/source-2/manifest.json",
    accessPolicy: "public",
    hostname: "docs.example.com",
    domainKind: "custom_domain",
    renderTarget: "production",
    ...overrides,
  };
}

export function warmMessage(overrides: Partial<DocsWarmMessage> = {}): DocsWarmMessage {
  return {
    v: 1,
    reason: "publish",
    siteId: "site-1",
    hostnames: ["docs.example.com"],
    releaseId: RELEASE,
    publishedVersionId: "version-2",
    jobId: JOB_ID,
    enqueuedAt: 1_000,
    ...overrides,
  };
}

export function warmJob(overrides: Partial<WarmJob> = {}): WarmJob {
  return {
    jobId: JOB_ID,
    siteId: "site-1",
    reason: "publish",
    releaseId: RELEASE,
    pool: "eu-west",
    targets: [
      { hostname: "docs.example.com", resolution: siteResolution(), resolvedAt: 5_000 },
    ],
    pages: ["/", "/guide"],
    startedAt: 10_000,
    ...overrides,
  };
}

/** A hostname map entry as `syncHostnames` stores it. */
export function mapEntry(resolution: DocsDomainResolution, resolvedAt: number): string {
  return JSON.stringify({ format: 1, resolvedAt, resolution });
}

/** Durable Object storage in memory; values are cloned like the real one. */
export class MemoryStorage implements WarmStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  readonly alarms: number[] = [];

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
    this.alarms.push(time);
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** A Durable Object state for the mocked `DurableObject` base class. */
export function objectState(storage: MemoryStorage, id = "object-1") {
  return {
    storage,
    id: { toString: () => id },
    waitUntil: () => undefined,
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
  };
}

export const cloudflareWorkersMock = () => ({
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
});
