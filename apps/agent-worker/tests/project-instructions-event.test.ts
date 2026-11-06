import { describe, expect, test, vi } from "vitest";
import {
  PROJECT_INSTRUCTIONS_EVENT_TYPE,
  recordProjectInstructions,
} from "../src/generation-workflow-runtime";
import type { Env } from "../src/index";

function envWith(addJobEvent: (...args: unknown[]) => Promise<unknown>): Pick<Env, "API"> {
  const api: Partial<Env["API"]> = { addJobEvent: vi.fn(addJobEvent) as Env["API"]["addJobEvent"] };
  return { API: api as Env["API"] };
}

describe("project instructions run-log event", () => {
  test("names the instructions version in the shape the run log reads", async () => {
    const env = envWith(async () => undefined);

    await recordProjectInstructions(env, "job-1", 4);

    expect(env.API.addJobEvent).toHaveBeenCalledWith("job-1", {
      type: PROJECT_INSTRUCTIONS_EVENT_TYPE,
      message: "Following your Doxabot instructions (version 4).",
      source: "worker",
      data: { version: 4 },
    });
    expect(PROJECT_INSTRUCTIONS_EVENT_TYPE).toBe("project_instructions_applied");
  });

  test("a failed write does not stop the run", async () => {
    const env = envWith(async () => {
      throw new Error("API unavailable");
    });

    await expect(recordProjectInstructions(env, "job-1", 4)).resolves.toBeUndefined();
  });
});
