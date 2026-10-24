import { z } from "zod";
import { defineMcpPrompt } from "./prompt-definition";
import {
  cleanupStep,
  MDX_RULE,
  projectLine,
  promptProjectIdArg,
  PUBLISH_STEP,
  quotedData,
  REVIEW_STEPS,
  workflow,
} from "./workflow-text";

/** About 20k tokens: enough for a PR summary or a focused diff. */
const MAX_CHANGE_LENGTH = 80_000;

export const updateFromCodeChangePrompt = defineMcpPrompt({
  name: "update_from_code_change",
  title: "Update docs from a code change",
  description:
    "Takes a code diff or a PR summary, finds the pages it affects, and updates them on a branch.",
  args: z
    .object({
      projectId: promptProjectIdArg,
      change: z
        .string()
        .trim()
        .min(1)
        .max(MAX_CHANGE_LENGTH)
        .describe("The code diff or the pull request summary."),
    })
    .strict(),
  text: ({ projectId, change }) =>
    workflow(
      [
        "Update a Doxa docs site after a code change.",
        projectLine(projectId),
        "",
        quotedData("The code change", change),
      ].join("\n"),
      [
        "List what the change means for readers: new, renamed, or removed APIs, commands, flags, options, config keys, defaults, error messages, and behavior. Ignore internal refactors that readers never see.",
        "For each item, call `search_docs` with its old and new names. Call `get_docs_structure` to see where a new feature belongs.",
        "Call `read_page` on each page that the search finds, and note the exact text to change. If no page needs a change, tell the user and stop.",
        'Call `create_branch` with a name like "agent-update-<change>". Use its ID as branch from now on.',
        `Change each page with \`write_page\` (the whole source) or \`edit_docs\` (several pages, or new pages with create_page). Keep the parts that the change does not touch as they are. ${MDX_RULE}`,
        "Call `search_docs` with the branch ID as branch and the old names, to check that no page still uses them.",
        ...REVIEW_STEPS,
        PUBLISH_STEP,
        cleanupStep("created"),
      ],
    ),
});
