import { normalizeDefaultText, plainTextSchema } from "./plain-text";

const MAX_SITE_NAME_LENGTH = 80;
const FALLBACK_SITE_NAME = "Documentation";

export const siteNameSchema =
  plainTextSchema(MAX_SITE_NAME_LENGTH).default(FALLBACK_SITE_NAME);

export function defaultSiteName(projectName: string): string {
  return (
    normalizeDefaultText(projectName, MAX_SITE_NAME_LENGTH) ||
    FALLBACK_SITE_NAME
  );
}
