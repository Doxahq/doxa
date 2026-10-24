export const WRITER_FINALIZATION_PROMPT = `CRITICAL — FINAL WRITING TURN

The repository research budget for this page has been reached. Tools are disabled for this turn.

Using only the source evidence, validation feedback, and draft information already present in this conversation, write the COMPLETE MDX documentation page now.

STRICT REQUIREMENTS:
- Return the entire page, not a summary, outline, partial continuation, or progress report.
- The first character of the response must be the first "-" in the opening frontmatter block.
- Include complete frontmatter and a complete, useful body with every necessary section.
- Preserve concrete, source-grounded facts and examples gathered during earlier tool calls.
- Resolve any validation feedback already present in the conversation.
- Do not call or describe tools.
- Do not mention the iteration limit, research budget, disabled tools, or unfinished work.
- Do not include a preamble, closing commentary, or an outer markdown code fence.

This is the final opportunity to produce the page. Spend the full response on the polished documentation page.`;
