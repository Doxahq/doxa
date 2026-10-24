import { describe, expect, test } from "vitest";
import {
  MemoryArtifactStore,
  MemoryStateStore,
  buildInfo,
  createDoxaAgent,
  doxaAgentVersion,
  planDocsGeneration,
} from "../src";
import agentPackageJson from "../package.json";

describe("public API", () => {
  test("exports the agent facade and foundational contracts", () => {
    expect(buildInfo).toEqual({
      packageName: "@doxahq/agent",
      version: agentPackageJson.version,
      entryFormat: "esm",
    });
    expect(doxaAgentVersion).toBe(agentPackageJson.version);
    expect(typeof createDoxaAgent).toBe("function");
    expect(typeof planDocsGeneration).toBe("function");
    expect(new MemoryStateStore()).toBeInstanceOf(MemoryStateStore);
    expect(new MemoryArtifactStore()).toBeInstanceOf(MemoryArtifactStore);
  });
});
