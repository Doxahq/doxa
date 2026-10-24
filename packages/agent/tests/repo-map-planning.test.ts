import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  analyzeProjectOnly,
  type ChatRequest,
  type Provider,
  type RepoMapOptions,
  type RepoMapTelemetry,
} from "../src";
import { REPO_MAP_EXPLORATION_MAX_STEPS } from "../src/doxa-agent/constants";
import { prompts } from "../src/doxa-agent/prompts";
import { analysisFixture } from "./fixtures";

/** The core agent loop's default turn cap (DEFAULT_MAX_STEPS). */
const DEFAULT_EXPLORATION_STEPS = 50;
const MAP_TEXT = "REPOSITORY MAP\n## packages/core (@acme/core): 1 file\n- src/index.ts: fn createClient";

describe("repo map prompt placement", () => {
  test("puts the map in the exploration and analysis system prompts, never the user body", () => {
    const exploration = prompts.buildExplorationPrompt({ cwd: "/fixture", repoMap: MAP_TEXT });
    const analysis = prompts.buildAnalysisPrompt({ explorationContext: "README found.", repoMap: MAP_TEXT });

    for (const prompt of [exploration, analysis]) {
      expect(prompt.system).toContain(MAP_TEXT);
      expect(prompt.user).not.toContain("REPOSITORY MAP");
    }
    expect(exploration.system).toContain(`at most ${REPO_MAP_EXPLORATION_MAX_STEPS} tool turns`);
  });

  test("renders the map after the shared policy sections so the prefix stays stable", () => {
    const exploration = prompts.buildExplorationPrompt({ cwd: "/fixture", repoMap: MAP_TEXT });
    const withoutMap = prompts.buildExplorationPrompt({ cwd: "/fixture" });

    expect(exploration.system.startsWith(withoutMap.system)).toBe(true);
    expect(exploration.system.indexOf("PUBLIC DOCUMENTATION POLICY")).toBeLessThan(exploration.system.indexOf(MAP_TEXT));
  });

  test("adds nothing when there is no map", () => {
    const exploration = prompts.buildExplorationPrompt({ cwd: "/fixture" });
    const analysis = prompts.buildAnalysisPrompt({ explorationContext: "README found." });
    expect(exploration.system).not.toContain("REPOSITORY MAP");
    expect(analysis.system).not.toContain("REPOSITORY MAP");
  });
});

describe("exploration with a repo map", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "doxa-repo-map-"));
    await writeProject(projectRoot, {
      "package.json": JSON.stringify({ name: "acme" }),
      "README.md": "# Acme\n",
      "src/index.ts": 'export { createClient } from "./client";\n',
      "src/client.ts": "export function createClient() {}\n",
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("caps exploration lower and finishes with a tool-free turn when a map exists", async () => {
    const recorder = recordingProvider();
    const telemetry: RepoMapTelemetry[] = [];

    await analyzeProjectOnly({
      cwd: projectRoot,
      toolPolicy: "read_only",
      provider: recorder.provider,
      repoMap: { onTelemetry: (event) => { telemetry.push(event); } },
    });

    expect(recorder.explorationRequests).toHaveLength(REPO_MAP_EXPLORATION_MAX_STEPS);
    expect(recorder.explorationRequests.slice(0, -1).every((request) => request.tools?.length)).toBe(true);
    expect(recorder.explorationRequests.at(-1)?.tools).toBeUndefined();

    const [system, user] = recorder.explorationRequests[0].messages;
    expect(system.content).toContain("REPOSITORY MAP");
    expect(system.content).toContain("createClient");
    expect(user.content).not.toContain("REPOSITORY MAP");
    expect(recorder.analysisRequests[0].messages[0].content).toContain("REPOSITORY MAP");
    expect(telemetry).toEqual([expect.objectContaining({ status: "ready", cacheHit: false })]);
  });

  test.each<[string, RepoMapOptions | false]>([
    ["turned off", false],
    ["over the limits", { limits: { maxSourceFiles: 0 } }],
  ])("explores as before when the map is %s", async (_label, repoMap) => {
    const recorder = recordingProvider();

    await analyzeProjectOnly({
      cwd: projectRoot,
      toolPolicy: "read_only",
      provider: recorder.provider,
      repoMap,
    });

    expect(recorder.explorationRequests).toHaveLength(DEFAULT_EXPLORATION_STEPS);
    expect(recorder.explorationRequests.every((request) => request.tools?.length)).toBe(true);
    expect(recorder.explorationRequests[0].messages[0].content).not.toContain("REPOSITORY MAP");
    expect(recorder.analysisRequests[0].messages[0].content).not.toContain("REPOSITORY MAP");
  });
});

async function writeProject(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/**
 * A provider whose explorer always asks for one more tool call while tools
 * are offered, so the turn cap alone decides how long exploration runs.
 */
function recordingProvider() {
  const explorationRequests: ChatRequest[] = [];
  const analysisRequests: ChatRequest[] = [];
  const provider: Provider = {
    config: { baseUrl: "https://example.invalid", apiKey: "test-key", model: "test-model" },
    async chat(request) {
      analysisRequests.push(request);
      return { message: { role: "assistant", content: JSON.stringify(analysisFixture) } };
    },
    async *chatStream(request) {
      explorationRequests.push(request);
      const step = explorationRequests.length;
      if (!request.tools) {
        yield { type: "done" as const, message: { role: "assistant" as const, content: "Exploration summary." } };
        return;
      }
      yield {
        type: "done" as const,
        message: {
          role: "assistant" as const,
          content: "Still exploring.",
          toolCalls: [{
            id: `call-${step}`,
            type: "function" as const,
            function: { name: "Glob", arguments: JSON.stringify({ pattern: `src/**/step-${step}.ts` }) },
          }],
        },
      };
    },
  };
  return { provider, explorationRequests, analysisRequests };
}
