import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { TokenUsage } from "./types";
import { addUsage, emptyUsage, subscribeUsage, type UsageRecord } from "./usage";

export type DocsCostTrackingStatus = "complete" | "error" | "cancelled";

export interface DocsCostTrackerOptions {
  workflow: "generate" | "update";
  targetPath: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export interface DocsCostTrackingReport {
  workflow: "generate" | "update";
  targetPath: string;
  status: DocsCostTrackingStatus;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  requestCount: number;
  missingCostCount: number;
  tokenUsage: TokenUsage;
  models: Record<string, {
    requestCount: number;
    missingCostCount: number;
    tokenUsage: TokenUsage;
  }>;
  metadata?: Record<string, unknown>;
  records: Array<{
    recordedAt: string;
    model?: string;
    generationId?: string;
    usage: TokenUsage;
  }>;
}

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export function isTruthyEnvValue(value: string | undefined): boolean {
  return value ? TRUTHY_ENV_VALUES.has(value.trim().toLowerCase()) : false;
}

export function isDevInvocation(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  if (env.npm_lifecycle_event === "dev") return true;
  return argv.some((arg) => /(?:^|[/\\])src[/\\]index\.tsx$/.test(arg));
}

export function isDocsCostTrackingEnabled(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  return isTruthyEnvValue(env.ENABLE_COST_TRACKING) || isDevInvocation(env, argv);
}

export class DocsCostTracker {
  private readonly startedAt = new Date();
  private readonly records: UsageRecord[] = [];
  private readonly unsubscribe: () => void;
  private finished = false;

  constructor(private readonly options: Required<DocsCostTrackerOptions>) {
    this.unsubscribe = subscribeUsage((record) => {
      this.records.push(record);
    });
  }

  async finish(
    status: DocsCostTrackingStatus,
    metadata?: Record<string, unknown>,
  ): Promise<DocsCostTrackingReport | null> {
    if (this.finished) return null;
    this.finished = true;
    this.unsubscribe();

    const report = this.buildReport(status, metadata);
    await this.persist(report);
    this.writeSummary(report);
    return report;
  }

  buildReport(
    status: DocsCostTrackingStatus,
    metadata?: Record<string, unknown>,
  ): DocsCostTrackingReport {
    const finishedAt = new Date();
    const models: DocsCostTrackingReport["models"] = {};
    let tokenUsage = emptyUsage();
    let missingCostCount = 0;

    for (const record of this.records) {
      tokenUsage = addUsage(tokenUsage, record.usage);
      if (record.usage.cost === undefined) missingCostCount++;

      const model = record.model ?? "unknown";
      const modelSummary = models[model] ?? {
        requestCount: 0,
        missingCostCount: 0,
        tokenUsage: emptyUsage(),
      };
      modelSummary.requestCount++;
      if (record.usage.cost === undefined) modelSummary.missingCostCount++;
      modelSummary.tokenUsage = addUsage(modelSummary.tokenUsage, record.usage);
      models[model] = modelSummary;
    }

    return {
      workflow: this.options.workflow,
      targetPath: this.options.targetPath,
      status,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      elapsedMs: finishedAt.getTime() - this.startedAt.getTime(),
      requestCount: this.records.length,
      missingCostCount,
      tokenUsage,
      models,
      metadata,
      records: this.records.map((record) => ({
        recordedAt: record.recordedAt,
        model: record.model,
        generationId: record.generationId,
        usage: record.usage,
      })),
    };
  }

  private async persist(report: DocsCostTrackingReport): Promise<void> {
    const safeTimestamp = report.finishedAt.replace(/[:.]/g, "-");
    const fileName = `${safeTimestamp}-${report.workflow}.json`;
    const outputDir = join(report.targetPath, ".doxa", "dev-debug", "cost-tracking");
    const outputPath = join(outputDir, fileName);

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.stderr.write(`[doxa:cost] failed to write cost report: ${message}\n`);
    }
  }

  private writeSummary(report: DocsCostTrackingReport): void {
    const tokens = report.tokenUsage;
    const elapsed = formatElapsed(report.elapsedMs);
    const cost = formatCost(tokens.cost, report.missingCostCount, report.requestCount);
    const summary = [
      `[doxa:cost] ${report.workflow} ${report.status}`,
      `elapsed=${elapsed}`,
      `requests=${report.requestCount}`,
      `tokens=${tokens.totalTokens} (${tokens.promptTokens} prompt, ${tokens.completionTokens} completion)`,
      `cost=${cost}`,
    ].join(" | ");

    this.options.stderr.write(`${summary}\n`);
  }
}

export function startDocsCostTracking(
  options: DocsCostTrackerOptions,
): DocsCostTracker | null {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  if (!isDocsCostTrackingEnabled(env, argv)) return null;

  return new DocsCostTracker({
    workflow: options.workflow,
    targetPath: options.targetPath,
    env,
    argv,
    stderr: options.stderr ?? process.stderr,
  });
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(
  cost: number | undefined,
  missingCostCount: number,
  requestCount: number,
): string {
  if (cost === undefined) {
    return requestCount === 0
      ? "unknown"
      : `unknown (${missingCostCount}/${requestCount} responses missing cost)`;
  }

  const missing = missingCostCount > 0
    ? `, ${missingCostCount}/${requestCount} responses missing cost`
    : "";
  return `${cost.toFixed(6)} credits${missing}`;
}
