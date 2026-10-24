import { beforeEach, describe, expect, test, vi } from "vitest";

import { searchDocs } from "./index";

describe("searchDocs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("requests ranked results from the current docs server", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          {
            id: "/quickstart",
            slug: "/quickstart",
            title: "Quickstart",
            breadcrumb: ["Start Here"],
            section: "default",
            snippetLine: "Install AI Memory.",
            score: 12,
            terms: ["memory"],
          },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchDocs("memory", 8);

    expect(results).toMatchObject([
      { slug: "/quickstart", title: "Quickstart" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=memory&limit=8",
      expect.objectContaining({ signal: undefined })
    );
  });

  test("returns no results for a query shorter than two characters", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchDocs("a")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
