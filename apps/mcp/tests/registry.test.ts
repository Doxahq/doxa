import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { OAUTH_SCOPES } from "@doxahq/contracts/agent-access";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RATE_LIMITS_PER_MINUTE } from "../src/rate-limit";
import { TOOLS } from "../src/tools";

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS_DIR = join(MCP_ROOT, "src/tools");
const MCP_DIR = join(MCP_ROOT, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function importsOf(path: string): string {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g)]
    .map((match) => match[0])
    .join("\n");
}

/** Spec 15.2: side effects for actions run in doxa-api, never in a tool. */
const FORBIDDEN_IN_TOOLS: Array<[string, RegExp]> = [
  ["DocsBranchPublish", /DocsBranchPublish|docs-branches\/publish/],
  ["DocsBranchHistory", /DocsBranchHistory|docs-branches\/history/],
  [
    "DocsDomainLifecycleService",
    /DocsDomainLifecycleService|docs-domain-lifecycle/,
  ],
  ["deleteProject", /\bdeleteProject\b|services\/project-deletion/],
  ["createExampleProject", /createExampleProject|example-docs\/create-project/],
  ["GenerationStartService", /\bGenerationStartService\b|services\/generation-start["']/],
];

describe("tool registry", () => {
  // v2 spec section 10: 31 v1 tools, plus delete_branch, get_branch_diff,
  // and upload_asset.
  it("registers 34 tools", () => {
    expect(TOOLS).toHaveLength(34);
  });

  it("counts upload_asset as an expensive docs:write tool", () => {
    const tool = TOOLS.find((item) => item.name === "upload_asset");
    expect(tool).toMatchObject({ scope: "docs:write", cost: "expensive" });
  });

  it("has unique tool names in the allowed shape", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
  });

  it("uses only known scopes", () => {
    const known: ReadonlySet<string | null> = new Set([...OAUTH_SCOPES, null]);
    for (const tool of TOOLS) expect(known.has(tool.scope)).toBe(true);
  });

  it("marks every read tool read-only and closed-world", () => {
    for (const tool of TOOLS.filter((item) => item.cost === "read")) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: false,
      });
    }
  });

  it("has strict input schemas and JSON-representable schemas", () => {
    for (const tool of TOOLS) {
      expect(z.toJSONSchema(tool.input, { io: "input" })).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(z.toJSONSchema(tool.output, { io: "output" })).toMatchObject({
        type: "object",
      });
    }
  });

  it("keeps the rate limit bindings in sync with rate-limit.ts", () => {
    const config = z
      .object({
        ratelimits: z.array(
          z.object({
            name: z.string(),
            simple: z.object({ limit: z.number(), period: z.number() }),
          }),
        ),
      })
      .parse(
        JSON.parse(readFileSync(join(MCP_ROOT, "wrangler.json"), "utf8")),
      );
    const byName = new Map(
      config.ratelimits.map((item) => [item.name, item.simple]),
    );
    expect(byName.get("MCP_READ_LIMITER")).toEqual({
      limit: RATE_LIMITS_PER_MINUTE.read,
      period: 60,
    });
    expect(byName.get("MCP_WRITE_LIMITER")).toEqual({
      limit: RATE_LIMITS_PER_MINUTE.write,
      period: 60,
    });
    expect(byName.get("MCP_EXPENSIVE_LIMITER")).toEqual({
      limit: RATE_LIMITS_PER_MINUTE.expensive,
      period: 60,
    });
  });
});

describe("MCP import boundaries", () => {
  it.each(FORBIDDEN_IN_TOOLS)("no tool imports %s", (_label, pattern) => {
    const offenders = sourceFiles(TOOLS_DIR).filter((path) =>
      pattern.test(importsOf(path)),
    );
    expect(offenders.map((path) => relative(MCP_ROOT, path))).toEqual([]);
  });

  it("no MCP module imports @doxahq/auth", () => {
    const files = sourceFiles(MCP_DIR);
    const offenders = files.filter((path) =>
      importsOf(path).includes("@doxahq/auth"),
    );
    expect(offenders.map((path) => relative(MCP_ROOT, path))).toEqual([]);
  });
});
