import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SyntheticLogLevel = "debug" | "info" | "warn" | "error";

export interface SyntheticLogEntry {
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  level: SyntheticLogLevel;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SyntheticReporterOptions {
  console?: boolean;
  logFile?: string;
}

export class SyntheticGenerationReporter {
  readonly entries: SyntheticLogEntry[] = [];
  private readonly startedAt = Date.now();
  private sequence = 0;

  constructor(private readonly options: SyntheticReporterOptions = {}) {}

  log(
    event: string,
    message: string,
    data?: Record<string, unknown>,
    level: SyntheticLogLevel = "info",
  ): SyntheticLogEntry {
    const entry: SyntheticLogEntry = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      level,
      event,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };
    this.entries.push(entry);
    if (this.options.console !== false) {
      const details = entry.data
        ? ` ${JSON.stringify(entry.data)}`
        : "";
      const line =
        `[synthetic-generation +${String(entry.elapsedMs).padStart(5, " ")}ms] ` +
        `${entry.event}: ${entry.message}${details}`;
      if (level === "error") {
        console.error(line);
      } else if (level === "warn") {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
    return entry;
  }

  async flush(): Promise<void> {
    if (!this.options.logFile) return;
    await mkdir(dirname(this.options.logFile), { recursive: true });
    const body = this.entries
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await writeFile(
      this.options.logFile,
      body.length > 0 ? `${body}\n` : "",
      "utf8",
    );
  }
}
