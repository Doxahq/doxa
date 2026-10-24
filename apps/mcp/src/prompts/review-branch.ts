import { z } from "zod";
import { defineMcpPrompt } from "./prompt-definition";
import {
  PUBLISH_STEP,
  projectLine,
  promptBranchIdArg,
  promptProjectIdArg,
  workflow,
} from "./workflow-text";

export const reviewBranchPrompt = defineMcpPrompt({
  name: "review_branch",
  title: "Review a branch",
  description:
    "Reads the branch diff and checks links, MDX, and style before a publish.",
  args: z
    .object({
      projectId: promptProjectIdArg,
      branchId: promptBranchIdArg,
    })
    .strict(),
  text: ({ projectId, branchId }) =>
    workflow(
      [
        "Review a Doxa docs branch before it is published.",
        projectLine(projectId),
        `Branch ID: ${branchId}. Pass it as branch.`,
      ].join("\n"),
      [
        "Call `get_branch_status`. If the branch is behind main, call `sync_branch` with dryRun true and report the result; the branch must be in sync before a publish.",
        "Call `get_branch_diff` and read every change. For a file marked truncated, call `read_page` with the branch for the full page.",
        "MDX: call `edit_docs` with dryRun true and one set_page_content edit for each changed page, with the source from `read_page`. ok false and issues list the MDX problems; nothing is written. A publish is blocked while a changed page has MDX issues.",
        "Links: call `get_docs_structure` with the branch to get the valid hrefs. In each changed page, check every internal link (markdown links and href props) against them. For each page the branch deletes or renames, call `search_docs` with its old href and title to find pages that still link to it.",
        "Style: compare each changed page with a nearby page from `read_page`. Check the frontmatter title and description, one h1 or none as the site does, heading order, code blocks with a language, and the same terms and tone.",
        "Report to the user: first the blocking problems (MDX issues, broken links, branch behind main), then suggestions, each with the page href and the line. Do not change the branch unless the user asks; then fix it with `write_page`.",
        `When the user approves the result: ${PUBLISH_STEP}`,
      ],
    ),
});
