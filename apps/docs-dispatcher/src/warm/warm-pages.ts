import type { DocsHostResolution } from "@doxahq/contracts";
import { normalizePublicDocsPathname } from "@doxahq/contracts/docs-prerender";
import { DOCS_WARM_HINT_PATH_LIMIT } from "@doxahq/contracts/docs-warm-job";
import { z } from "zod";

import { requestDocsRuntime } from "../runtime-trace";
import type { DocsRuntimeRpc } from "../worker-exports";

/**
 * Which pages a warm job fills, in which order (M45, D9): home, then the
 * publisher's changed pages, then navigation order, then the rest of the
 * plan. Only pages of the plan are ever warmed: a hint orders, never adds.
 */

/** Sections read for navigation order; the rest keep plan order. */
const MAX_NAVIGATION_SECTIONS = 20;

const planEntrySchema = z.object({
  kind: z.string(),
  pathname: z.string(),
});

const sectionSchema = z.object({
  slug: z.string().min(1),
  hidden: z.boolean().optional(),
});

const routeSchema = z.object({ href: z.string() });

/**
 * The page pathnames of a pre-render plan (manifest order). Redirect and
 * `live_only` entries are skipped: a 308 is not cached, and a live-only
 * route has no saved output (F5).
 */
export function parseWarmPlan(value: unknown): string[] {
  const parsed = z.array(planEntrySchema).safeParse(value);
  if (!parsed.success) throw new Error("The pre-render plan is invalid.");
  return parsed.data.flatMap((entry) => {
    if (entry.kind !== "page") return [];
    const pathname = normalizeOrNull(entry.pathname);
    return pathname ? [pathname] : [];
  });
}

/** The plan of one published version, read once per job. */
export async function readWarmPlan(
  runtime: Pick<DocsRuntimeRpc, "request">,
  resolution: DocsHostResolution,
): Promise<string[]> {
  const answer = await requestDocsRuntime(
    runtime,
    { resolution, operation: "getPrerenderPlan" },
    "plan",
  );
  if (!answer.ok) throw new Error("The docs runtime could not build a pre-render plan.");
  return parseWarmPlan(answer.data);
}

/**
 * Navigation order (F32): the sidebar routes of each visible section, the
 * cheapest existing runtime reads (`getSections`, `getRoutes`). Any failure
 * returns what was read so far: order is a nicety, never a reason to fail.
 */
export async function readNavigationOrder(
  runtime: Pick<DocsRuntimeRpc, "request">,
  resolution: DocsHostResolution,
): Promise<string[]> {
  try {
    const sections = await readList(runtime, resolution, "getSections", sectionSchema);
    const visible = sections
      .filter((section) => !section.hidden)
      .slice(0, MAX_NAVIGATION_SECTIONS);
    const routes = await Promise.all(
      visible.map((section) =>
        readList(runtime, resolution, "getRoutes", routeSchema, {
          sectionSlug: section.slug,
        }).catch(() => []),
      ),
    );
    return routes.flat().flatMap((route) => {
      const pathname = normalizeOrNull(route.href);
      return pathname ? [pathname] : [];
    });
  } catch {
    return [];
  }
}

export function orderWarmPages(input: {
  plan: readonly string[];
  navigation: readonly string[];
  priorityPaths: readonly string[];
  maxPages: number;
}): string[] {
  const inPlan = new Set(input.plan);
  const priority = input.priorityPaths
    .slice(0, DOCS_WARM_HINT_PATH_LIMIT)
    .flatMap((path) => {
      const pathname = normalizeOrNull(path);
      return pathname && inPlan.has(pathname) ? [pathname] : [];
    });
  const ordered = new Set<string>();
  if (inPlan.has("/")) ordered.add("/");
  for (const pathname of [...priority, ...input.navigation, ...input.plan]) {
    if (ordered.size >= input.maxPages) break;
    if (inPlan.has(pathname)) ordered.add(pathname);
  }
  return [...ordered].slice(0, input.maxPages);
}

/** A normalized page path as it appears in a request URL (percent-encoded). */
export function toRequestPathname(pathname: string): string {
  return new URL(pathname, "https://warm.invalid").pathname;
}

async function readList<T>(
  runtime: Pick<DocsRuntimeRpc, "request">,
  resolution: DocsHostResolution,
  operation: string,
  item: z.ZodType<T>,
  payload?: unknown,
): Promise<T[]> {
  const answer = await requestDocsRuntime(
    runtime,
    { resolution, operation, ...(payload === undefined ? {} : { payload }) },
    "plan",
  );
  if (!answer.ok || !Array.isArray(answer.data)) return [];
  return answer.data.flatMap((value) => {
    const parsed = item.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

function normalizeOrNull(pathname: string): string | null {
  try {
    return normalizePublicDocsPathname(pathname);
  } catch {
    return null;
  }
}
