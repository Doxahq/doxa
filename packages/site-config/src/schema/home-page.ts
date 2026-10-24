import { hrefSchema } from "../primitives/href";

/**
 * The page that the site root (`/`) shows: the href of one docs page, such as
 * `/guides/intro`. Only a page on the same site is allowed.
 */
export const homePageSchema = hrefSchema.refine(
  (value) => value.startsWith("/"),
  { params: { siteConfigCode: "invalid_href" } },
);

interface HomePageConfig {
  homePage?: string;
}

/**
 * The page that the site root shows: the one place that resolves it.
 *
 * A config without `homePage`, or with a `homePage` that names no page (for
 * example a deleted page), uses `fallbackHref`: the first page of the default
 * section. A stale value therefore never breaks a site.
 */
export function resolveHomeHref(
  config: HomePageConfig,
  hasPage: (href: string) => boolean,
  fallbackHref: string | null,
): string | null {
  const chosen = config.homePage;
  if (chosen && hasPage(chosen)) return chosen;
  return fallbackHref;
}
