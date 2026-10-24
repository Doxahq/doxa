import { z } from "zod";

/** "The live site at acme.doxa.page" or "The live site" when it has no URL. */
export function liveSiteLabel(liveUrl: string | null): string {
  if (liveUrl === null) return "The live site";
  try {
    return `The live site at ${new URL(liveUrl).host}`;
  } catch {
    return "The live site";
  }
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export const emptySchema = z.object({}).strict();
