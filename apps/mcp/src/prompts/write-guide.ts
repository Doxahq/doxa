import { z } from "zod";
import { defineMcpPrompt } from "./prompt-definition";
import {
  cleanupStep,
  MDX_RULE,
  projectLine,
  promptProjectIdArg,
  PUBLISH_STEP,
  REVIEW_STEPS,
  workflow,
} from "./workflow-text";

export const writeGuidePrompt = defineMcpPrompt({
  name: "write_guide",
  title: "Write a guide",
  description:
    "Plans and writes a new guide page on a branch, then builds a preview.",
  args: z
    .object({
      projectId: promptProjectIdArg,
      topic: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("What the guide teaches. Leave it out to ask the user."),
      audience: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Who reads the guide, for example new users or operators."),
    })
    .strict(),
  text: ({ projectId, topic, audience }) =>
    workflow(
      [
        "Write a new guide page for a Doxa docs site.",
        projectLine(projectId),
        topic
          ? `Topic: ${topic}`
          : "Topic: not given. Ask the user what the guide must teach before you start.",
        audience
          ? `Audience: ${audience}`
          : "Audience: not given. Match the readers of the existing pages.",
      ].join("\n"),
      [
        "Call `get_docs_structure` to see the sections, groups, and pages. Pick the section and group where the guide belongs.",
        "Call `search_docs` with the main terms of the topic. If a page already covers it, tell the user and offer to extend that page instead of writing a duplicate.",
        "Call `read_page` on one or two nearby pages to match their tone, headings, and frontmatter.",
        'Call `create_branch` with a name like "agent-guide-<topic>". Use its ID as branch from now on.',
        "Call `edit_docs` with a create_page edit (sectionSlug, groupIndex, title, slug) to add the page.",
        `Plan the guide: goal, prerequisites, numbered steps with commands or code, the expected result, and next steps that link to related pages. ${MDX_RULE}`,
        "Call `read_page` on the new page for its revision, then call `write_page` with the full MDX source, frontmatter included. For an image, call `create_asset_upload` on the branch, send the file to the returned URL with the curl command, call `finish_asset_upload`, and use the returned path.",
        ...REVIEW_STEPS,
        PUBLISH_STEP,
        cleanupStep("created"),
      ],
    ),
});
