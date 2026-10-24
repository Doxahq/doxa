import type { McpServer } from "@modelcontextprotocol/server";
import { fixBrokenLinksPrompt } from "./fix-broken-links";
import { toPromptResult, type AnyMcpPrompt } from "./prompt-definition";
import { reviewBranchPrompt } from "./review-branch";
import { updateFromCodeChangePrompt } from "./update-from-code-change";
import { writeGuidePrompt } from "./write-guide";

/** Spec 8.2: tested workflows that name the steps and the tools. */
export const PROMPTS: readonly AnyMcpPrompt[] = [
  writeGuidePrompt,
  updateFromCodeChangePrompt,
  reviewBranchPrompt,
  fixBrokenLinksPrompt,
];

/** The SDK validates the arguments with `args` before `text` runs. */
export function registerPrompts(
  server: McpServer,
  prompts: readonly AnyMcpPrompt[] = PROMPTS,
): void {
  for (const prompt of prompts) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.args,
      },
      (args) => toPromptResult(prompt, prompt.text(args)),
    );
  }
}
