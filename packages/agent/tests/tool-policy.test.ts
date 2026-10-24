import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createTrackedExplorationTools,
  explorationTools,
} from "../src/core";
import { globTool } from "../src/core/tools/glob";
import { grepTool } from "../src/core/tools/grep";
import type { AgentToolPolicy } from "../src/types";

const runCommand = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/utils/runtime")>(),
  runCommand,
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  runCommand.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

const TOOL_POLICY_CASES = [
  {
    policy: "read_only",
    expectedNames: ["Read", "Glob", "Grep"],
  },
  {
    policy: "local_shell",
    expectedNames: ["Read", "Glob", "Grep", "Bash"],
  },
] satisfies ReadonlyArray<{
  policy: AgentToolPolicy;
  expectedNames: string[];
}>;

describe("agent tool policy", () => {
  test.each(TOOL_POLICY_CASES)(
    "$policy exposes only its explicitly allowed exploration tools",
    ({ policy, expectedNames }) => {
      const tools = explorationTools("/project", policy);

      expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
    },
  );

  test.each(TOOL_POLICY_CASES)(
    "$policy also applies to tracked exploration tools",
    ({ policy, expectedNames }) => {
      const tracked = createTrackedExplorationTools("/project", policy);

      expect(tracked.tools.map((tool) => tool.name)).toEqual(expectedNames);
    },
  );
});

describe("repository search policy", () => {
  test("grep excludes generated and dependency directories and ignores binary files", async () => {
    const project = await temporaryProject();
    runCommand.mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    });

    await grepTool(project).execute({ pattern: "createClient" });

    expect(runCommand).toHaveBeenCalledOnce();
    const [command, options] = runCommand.mock.calls[0]!;
    expect(command).toEqual(expect.arrayContaining([
      "grep",
      "-rn",
      "-I",
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      "--exclude-dir=dist",
      "--exclude-dir=build",
      "--exclude-dir=.next",
      "--exclude-dir=coverage",
    ]));
    expect(options).toMatchObject({ cwd: project, timeoutMs: 10_000 });
  });

  test("grep converts a command timeout into a bounded tool error", async () => {
    const project = await temporaryProject();
    runCommand.mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      timedOut: true,
    });

    await expect(
      grepTool(project).execute({ pattern: "(pathological)+" }),
    ).resolves.toBe(
      "Error: grep timed out after 10000ms; narrow the path or pattern",
    );
  });

  test("glob skips generated and dependency directories", async () => {
    const project = await temporaryProject();
    await Promise.all(
      [".git", "node_modules", "dist", "build", ".next", "coverage"].map(
        async (directory) => {
          await mkdir(join(project, directory), { recursive: true });
          await writeFile(join(project, directory, "ignored.ts"), "ignored");
        },
      ),
    );

    await expect(
      globTool(project).execute({ pattern: "**/*.ts" }),
    ).resolves.toBe("src/included.ts");
  });
});

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "doxa-tool-policy-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "src", "included.ts"), "included");
  return directory;
}
