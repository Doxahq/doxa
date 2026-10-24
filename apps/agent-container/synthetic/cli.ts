import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSyntheticGenerationPipeline,
  type SyntheticGenerationRunResult,
} from "./runner";

interface CliOptions {
  seed: number;
  runs: number;
  logDir: string;
  console: boolean;
  keepWorkspace: boolean;
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const startedAt = Date.now();
  const results: SyntheticGenerationRunResult[] = [];
  const failures: Array<{ seed: number; error: string; logFile: string }> = [];

  console.log(
    `Running ${options.runs} synthetic generation scenario(s) ` +
      `from seed ${options.seed}.`,
  );
  console.log(`JSONL logs: ${options.logDir}`);

  for (let index = 0; index < options.runs; index += 1) {
    const seed = (options.seed + index) >>> 0 || 1;
    const logFile = resolve(options.logDir, `seed-${seed}.jsonl`);
    try {
      const result = await runSyntheticGenerationPipeline({
        seed,
        console: options.console,
        logFile,
        keepWorkspace: options.keepWorkspace,
      });
      results.push(result);
      console.log(
        `PASS seed=${seed} project=${JSON.stringify(result.projectName)} ` +
          `pages=${result.pageCount} modelCalls=${result.modelCalls.length} ` +
          `version=${result.versionId}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      failures.push({ seed, error: message, logFile });
      console.error(
        `FAIL seed=${seed} error=${JSON.stringify(message)} log=${logFile}`,
      );
    }
  }

  console.log(
    `Synthetic generation finished in ${Date.now() - startedAt}ms: ` +
      `${results.length} passed, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

function parseArguments(arguments_: string[]): CliOptions {
  let seed = Math.max(1, Date.now() >>> 0);
  let runs = 3;
  let logDir = resolve(
    repositoryRoot,
    ".artifacts",
    "synthetic-generation",
  );
  let consoleOutput = true;
  let keepWorkspace = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }
    if (argument === "--quiet") {
      consoleOutput = false;
      continue;
    }
    if (argument === "--keep-workspace") {
      keepWorkspace = true;
      continue;
    }
    if (argument === "--seed") {
      seed = positiveInteger(
        arguments_[++index],
        "--seed",
      );
      continue;
    }
    if (argument === "--runs") {
      runs = positiveInteger(
        arguments_[++index],
        "--runs",
      );
      continue;
    }
    if (argument === "--log-dir") {
      const value = arguments_[++index];
      if (!value) throw new Error("--log-dir requires a path.");
      logDir = resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    seed,
    runs,
    logDir,
    console: consoleOutput,
    keepWorkspace,
  };
}

function positiveInteger(
  value: string | undefined,
  flag: string,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Synthetic generation pipeline

Usage:
  pnpm test:generation:synthetic [options]

Options:
  --seed <number>       Base seed. Each additional run increments it.
  --runs <number>       Number of scenarios to run (default: 3).
  --log-dir <path>      JSONL output directory.
  --quiet               Hide detailed live events; keep JSONL logs.
  --keep-workspace      Preserve temporary Git and container workspaces.
  --help                Show this help.

Replay one failure:
  pnpm test:generation:synthetic --seed 1729 --runs 1
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
