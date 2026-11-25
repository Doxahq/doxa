import type { AnalyticsRecord, AnalyticsSink } from "../../sink";

export const MEMORY_PROVIDER = "memory";

type RecordOf<Kind extends AnalyticsRecord["kind"]> = Extract<AnalyticsRecord, { kind: Kind }>;

/** Keeps every record in memory, for tests. */
export class MemoryAnalyticsSink implements AnalyticsSink {
  readonly provider = MEMORY_PROVIDER;
  readonly records: AnalyticsRecord[] = [];
  flushCount = 0;
  isShutDown = false;

  send(record: AnalyticsRecord): void {
    if (this.isShutDown) throw new Error("The memory analytics sink is shut down.");
    this.records.push(record);
  }

  /** The records of one kind, in the order they arrived. */
  recordsOf<Kind extends AnalyticsRecord["kind"]>(kind: Kind): RecordOf<Kind>[] {
    return this.records.filter((record): record is RecordOf<Kind> => record.kind === kind);
  }

  eventNames(): string[] {
    return this.recordsOf("event").map((record) => record.event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  async shutdown(): Promise<void> {
    this.isShutDown = true;
  }
}
