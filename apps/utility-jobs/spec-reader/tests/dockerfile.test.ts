import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";

describe("spec-reader image", () => {
  let dockerfile = "";
  let finalStage = "";

  beforeAll(async () => {
    dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  });

  test("builds in one stage and runs from a clean Node 26 stage", () => {
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(2);
    expect(dockerfile).toMatch(/^FROM node:26-slim AS build$/m);
    expect(finalStage).toMatch(/^FROM node:26-slim$/m);
  });

  test("copies only the supervisor and the job bundle into the final stage", () => {
    const copies = finalStage.match(/^COPY [\s\S]*?(?<!\\)$/gm) ?? [];

    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain("--from=build");
    expect(copies[0]!.match(/\S+\.mjs/g)).toEqual([
      "/src/apps/utility-jobs/spec-reader/dist/supervisor.mjs",
      "/src/apps/utility-jobs/spec-reader/dist/job.mjs",
    ]);
  });

  test("removes the package managers from the final stage", () => {
    for (const tool of ["npm", "npx", "corepack", "yarn"]) {
      expect(finalStage).toContain(`/usr/local/bin/${tool}`);
    }
    expect(finalStage).toContain("rm -rf /usr/local/lib/node_modules");
  });

  test("runs the supervisor as the node user with the inspector signal off", () => {
    expect(finalStage).toContain("USER node");
    expect(finalStage.indexOf("USER node")).toBeLessThan(finalStage.indexOf("CMD"));
    expect(finalStage).toContain('CMD ["node", "--disable-sigusr1", "/app/job/supervisor.mjs"]');
    expect(finalStage).not.toMatch(/^ENV /m);
  });
});
