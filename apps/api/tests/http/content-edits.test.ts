import { describe, expect, test } from "vitest";
import {
  containsOversizedConfig,
  parseContentEdits,
} from "../../src/http/content-edits";
import { SITE_CONFIG_LIMITS } from "@doxahq/site-config";
import {
  readBoundedBody,
  RequestBodyTooLarge,
} from "../../src/http/bounded-body";

describe("raw config size limits", () => {
  test.each([-1, 0, 1])(
    "checks the raw config size at boundary %+d",
    (delta) => {
      const config = `{${" ".repeat(SITE_CONFIG_LIMITS.configBytes - 2 + delta)}}`;
      expect(
        containsOversizedConfig(
          `{"edits":[{"type":"set_site_config","config":${config}}]}`,
        ),
      ).toBe(delta > 0);
    },
  );
  test("checks escaped property names", () => {
    expect(
      containsOversizedConfig(
        `{"c\\u006fnfig":{"name":"${"x".repeat(65536)}"}}`,
      ),
    ).toBe(true);
  });
  test("ignores a config token inside page text", () => {
    expect(
      containsOversizedConfig(
        JSON.stringify({
          edits: [
            {
              type: "set_page_content",
              href: "/",
              content: `"config": "${"x".repeat(65536)}"`,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  test("counts UTF-8 bytes rather than string length", () => {
    expect(
      containsOversizedConfig(
        JSON.stringify({ config: { name: "界".repeat(24000) } }),
      ),
    ).toBe(true);
  });
  test("rejects an oversized config before invalid JSON parsing", async () => {
    const result = await parseContentEdits(
      new Request("https://api.test/edits", {
        method: "POST",
        body: `{"config":{${" ".repeat(65536)}} INVALID`,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(422);
      await expect(result.response.json()).resolves.toMatchObject({
        error: {
          details: {
            issues: [expect.objectContaining({ code: "config_too_large" })],
          },
        },
      });
    }
  });
  test("returns a depth issue", async () => {
    const config = {
      x: { x: { x: { x: { x: { x: { x: { x: { x: {} } } } } } } } },
    };
    const result = await parseContentEdits(
      new Request("https://api.test/edits", {
        method: "POST",
        body: JSON.stringify({ edits: [{ type: "set_site_config", config }] }),
      }),
    );
    if (result.ok) throw new Error("Expected rejection");
    await expect(result.response.json()).resolves.toMatchObject({
      error: {
        details: { issues: [expect.objectContaining({ code: "too_deep" })] },
      },
    });
  });
  test("rejects a stream beyond the byte limit without content-length", async () => {
    const request = new Request("https://api.test/", {
      method: "POST",
      body: "12345",
    });
    await expect(readBoundedBody(request, 4)).rejects.toBeInstanceOf(
      RequestBodyTooLarge,
    );
  });
});
