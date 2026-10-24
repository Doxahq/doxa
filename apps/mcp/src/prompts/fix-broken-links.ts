import { defineMcpPrompt } from "./prompt-definition";
import { z } from "zod";
import {
  cleanupStep,
  projectLine,
  promptBranchIdArg,
  promptProjectIdArg,
  PUBLISH_STEP,
  REVIEW_STEPS,
  workflow,
} from "./workflow-text";

export const fixBrokenLinksPrompt = defineMcpPrompt({
  name: "fix_broken_links",
  title: "Fix broken links",
  description:
    "Finds links to missing pages and fixes them on a branch.",
  args: z
    .object({
      projectId: promptProjectIdArg,
      branchId: promptBranchIdArg
        .optional()
        .describe(
          "A branch to check and fix. Leave it out to check the live site and fix it on a new branch.",
        ),
    })
    .strict(),
  text: ({ projectId, branchId }) => {
    const target = branchId
      ? `Branch ID: ${branchId}. Read and fix this branch; pass it as branch.`
      : 'No branch given. Read the live site ("main"), and fix it on a new branch.';
    return workflow(
      [
        "Find and fix links to missing pages in a Doxa docs site. Doxa has no link checker tool, so you check the links yourself.",
        projectLine(projectId),
        target,
      ].join("\n"),
      [
        "Call `get_docs_structure` (with the branch, if one is given) and keep the set of valid page hrefs.",
        'Call `read_page` on each page and collect its internal links: markdown links such as [text](/guides/setup), and href props such as <Card href="/guides/setup">. Resolve relative links against the page href. Skip external links, mailto links, and links that are only an #anchor.',
        'A link is broken when its path, without the #anchor and the trailing slash, is not a valid href. Note the page, the line, the link text, and the target.',
        "For each broken link, find where the page went: call `search_docs` with the link text and the last part of the target path, and pick the page that matches. If no page matches, plan to remove the link and keep its text.",
        branchId
          ? "Work on the given branch."
          : 'Call `create_branch` with a name like "agent-fix-links". Use its ID as branch from now on.',
        "For each page with broken links, call `read_page` on the branch for its revision, then call `write_page` with only the link targets changed. Keep the rest of the source byte for byte.",
        ...REVIEW_STEPS,
        "Tell the user which links you changed, and which ones you removed because no page matched.",
        PUBLISH_STEP,
        cleanupStep(branchId ? "own" : "created"),
      ],
    );
  },
});
