import {
  runtimeSearchResponseSchema,
  type RuntimeSearchResult,
} from "@doxahq/docs-search/contracts";

export async function searchDocs(
  query: string,
  limit = 8,
  signal?: AbortSignal
): Promise<RuntimeSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const search = new URLSearchParams({
    q: trimmed,
    limit: String(limit),
  });

  try {
    const response = await fetch(`/api/search?${search}`, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) return [];

    const parsed = runtimeSearchResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.results : [];
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return [];
    console.warn("[search] request failed", error);
    return [];
  }
}

export type SearchResult = RuntimeSearchResult;
