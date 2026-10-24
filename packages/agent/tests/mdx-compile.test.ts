import { afterEach, describe, expect, test } from "vitest";
import { assertMdxValidatorReady, compileMdx } from "../src/utils/mdx-compile";
import type { AgentSpanRecord } from "../src/core/types";
import {
  disposeMdxValidatorPool,
  getSharedMdxValidatorPool,
} from "../src/utils/mdx-validator-pool";

const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await disposeMdxValidatorPool();
});

describe("MDX compiler runtime", () => {
  test("validates MDX with the current Node runtime without relying on Bun from PATH", async () => {
    process.env.PATH = "";

    const result = await compileMdx("# Runtime readiness\n");

    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("startup readiness rejects a missing validator with its infrastructure error", async () => {
    await expect(assertMdxValidatorReady({
      scriptPath: "/definitely-missing/doxa-mdx-validator.mjs",
    })).rejects.toThrow(
      "MDX validator startup check failed: Validator script not found",
    );
  });

  test("emits validation spans for successful and crashed validators", async () => {
    const spans: AgentSpanRecord[] = [];
    const onSpan = (span: AgentSpanRecord) => {
      spans.push(span);
    };

    await expect(compileMdx("# Valid page\n", { onSpan })).resolves.toEqual({
      ok: true,
      errors: [],
    });
    const crashed = await compileMdx("# Invalid infrastructure\n", {
      onSpan,
      scriptPath: "/definitely-missing/doxa-mdx-validator.mjs",
    });

    expect(crashed).toMatchObject({
      ok: false,
      errors: [{ rule: "validator-crashed" }],
    });
    expect(spans).toEqual([
      expect.objectContaining({
        kind: "validation",
        name: "mdx_compile",
        ok: true,
      }),
      expect.objectContaining({
        kind: "validation",
        name: "mdx_compile",
        ok: false,
      }),
    ]);
    expect(spans.every((span) => span.durationMs >= 0)).toBe(true);
  });

  test("keeps valid and invalid results stable across pooled calls", async () => {
    const pool = getSharedMdxValidatorPool();
    const initialSpawnCount = pool.spawnCount;
    const sources = [
      "# Valid one\n",
      "<Tabs>\n",
      "# Valid two\n",
      "## Also valid\n\nText.\n",
      "<Unclosed>\n",
    ];

    const results = await Promise.all(sources.map((source) => compileMdx(source)));

    expect(results.map((result) => result.ok)).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(results[1]?.errors[0]?.rule).toBe("end-tag-mismatch");
    expect(results[4]?.errors[0]?.rule).toBe("end-tag-mismatch");
    expect(pool.spawnCount - initialSpawnCount).toBeLessThanOrEqual(4);
  });

  test("rejects components the runtime renderer has not registered", async () => {
    const result = await compileMdx(
      "# Invalid component\n\n<Warning>Stop.</Warning>\n",
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          rule: "mdx-runtime-incompatible",
          message: expect.stringContaining("Unknown MDX component: Warning"),
        },
      ],
    });
  });
});
