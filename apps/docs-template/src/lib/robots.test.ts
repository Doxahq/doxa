import { describe, expect, test } from "vitest";

import { createRobotsResponse } from "./robots";

describe("createRobotsResponse", () => {
  test.each(["https://docs.acme.com", "https://acme.doxa.page"])(
    "allows crawlers and names the sitemap of %s",
    async (origin) => {
      const response = createRobotsResponse(new Request(`${origin}/robots.txt`));

      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe(
        `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`
      );
    }
  );
});
