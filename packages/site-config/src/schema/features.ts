import { z } from "zod";

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
    rawMarkdown: z.boolean().default(true),
    loadFromGithub: z.boolean().default(false),
  })
  .strict();
