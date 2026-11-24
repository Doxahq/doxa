import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, test } from "vitest";

describe("agent container image", () => {
  let dockerfile = "";

  beforeAll(async () => {
    dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  });

  test("installs git for repository cloning", async () => {
    expect(dockerfile).toMatch(/apt-get install\b[\s\S]*\bgit\b/);
  });

  test("installs certificate store for HTTPS cloning", async () => {
    expect(dockerfile).toMatch(/apt-get install\b[\s\S]*\bca-certificates\b/);
  });

  test("keeps apt install minimal", async () => {
    expect(dockerfile).toContain("--no-install-recommends");
  });

  test("cleans apt package indexes", async () => {
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
  });

  test("uses production start command", async () => {
    expect(dockerfile).toContain('CMD ["pnpm", "--filter", "@doxahq/agent-container", "start"]');
    expect(dockerfile).not.toContain('CMD ["pnpm", "--filter", "@doxahq/agent-container", "dev"]');
  });

  test("builds and executes the agent runtime preflight before producing an image", async () => {
    const build = "RUN pnpm --filter @doxahq/agent... build";
    const preflight = "RUN pnpm --filter @doxahq/agent preflight";

    expect(dockerfile).toContain(build);
    expect(dockerfile).toContain(preflight);
    expect(dockerfile.indexOf(build)).toBeLessThan(dockerfile.indexOf(preflight));
    expect(dockerfile.indexOf(preflight)).toBeLessThan(dockerfile.indexOf("CMD"));
  });

  test("copies the shared TypeScript configuration required by the agent build", async () => {
    expect(dockerfile).toContain("COPY tsconfig.base.json ./");
  });

  test("runs on Node 26", async () => {
    expect(dockerfile).toMatch(/^FROM node:26-slim\b/m);
  });

  test("installs the pinned pnpm version without Corepack", async () => {
    const rootPackage = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
    const packageManager = rootPackage.match(/"packageManager":\s*"(pnpm@[^"]+)"/)?.[1];

    expect(packageManager).toBeDefined();
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).toContain(`RUN npm install -g ${packageManager}`);
  });

  test("stops child processes from opening the inspector of the agent process", async () => {
    expect(dockerfile).toContain("ENV NODE_OPTIONS=--disable-sigusr1");
    expect(dockerfile.indexOf("ENV NODE_OPTIONS=--disable-sigusr1")).toBeLessThan(
      dockerfile.indexOf("CMD"),
    );
  });

  test("starts through the egress CA entrypoint, which keeps the start command", async () => {
    const entrypoint = 'ENTRYPOINT ["sh", "/app/apps/agent-container/scripts/trust-egress-ca.sh"]';
    expect(dockerfile).toContain(entrypoint);
    expect(dockerfile.indexOf("COPY apps/agent-container ./apps/agent-container")).toBeLessThan(
      dockerfile.indexOf(entrypoint),
    );
    expect(dockerfile.indexOf(entrypoint)).toBeLessThan(dockerfile.indexOf("CMD"));
  });

  test("runs generation as the unprivileged node user", async () => {
    expect(dockerfile).toContain("ENV DOXA_WORKSPACE_ROOT=/app");
    expect(dockerfile).toContain("chown node:node /app/.workspaces");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile.indexOf("USER node")).toBeLessThan(
      dockerfile.indexOf("CMD"),
    );
  });
});
