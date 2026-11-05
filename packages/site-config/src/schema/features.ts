import { z } from "zod";

const ROOT_RELATIVE_PATH = /^\/(?!\/)/;

/** An http(s) URL without credentials, or a path on the docs host itself. */
function isPlaygroundBaseUrl(value: string): boolean {
  if (ROOT_RELATIVE_PATH.test(value)) return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
}

/**
 * Where the API playground sends "Try it" requests (SEC-010): an http(s) URL
 * or a root-relative path on the docs host. Only the site owner sets it. The
 * `baseUrl` of an `ApiEndpoint` in page content never decides where a
 * reader's API key goes, because page content is untrusted.
 */
export const apiPlaygroundBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isPlaygroundBaseUrl, "Use an http(s) URL or a path that starts with /.");

/**
 * Who sends "Try it" requests. Unset means the proxy: `doxa-try-proxy` sends
 * them, so the API needs no CORS setup. `browser` means the reader's browser
 * sends them, so a reader's key never passes through Doxa.
 */
export const apiPlaygroundTransportSchema = z.enum(["proxy", "browser"]);

/**
 * Which search a site asks for. Unset means the default of the site's plan.
 * The plan decides at publish time, so a stored choice never gives a site a
 * provider that its plan does not allow.
 */
export const searchProviderChoiceSchema = z.enum(["typesense", "minisearch"]);

export const featuresSchema = z
  .object({
    branding: z.boolean().default(true),
    rightSidebar: z.boolean().default(true),
    feedbackEdit: z.boolean().default(false),
    tableOfContents: z.boolean().default(true),
    scrollToTop: z.boolean().default(true),
    AgressiveNavPrefetch: z.boolean().default(true),
    ai: z
      .object({
        chat: z.boolean().default(false),
        chatWithPage: z.boolean().default(false),
        floatingInput: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    copyPage: z
      .object({
        markdown: z.boolean().default(true),
        rawText: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    apiPlayground: z.boolean().default(true),
    // No default: a site without it keeps its stored shape, and Try it stays off.
    apiPlaygroundBaseUrl: apiPlaygroundBaseUrlSchema.optional(),
    // No default, for the same reason.
    apiPlaygroundTransport: apiPlaygroundTransportSchema.optional(),
    rawMarkdown: z.boolean().default(true),
    loadFromGithub: z.boolean().default(false),
    // No default, for the same reason.
    searchProvider: searchProviderChoiceSchema.optional(),
  })
  .strict();
