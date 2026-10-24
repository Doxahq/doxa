# @doxahq/agent

Shared Doxa documentation-generation agent.

This package owns Doxa's agent behavior, state contracts, and incremental
generation planning. Concrete hosts provide adapters for source access,
artifact persistence, state persistence, and event handling.

The public CLI and private platform should consume this package instead of
forking agent behavior.

### Writer loop limits

Writer `maxSteps` counts model iterations, not individual tool calls. Doxa
currently configures 12 total writer iterations. When a writer reaches the
boundary, iteration 12 is still executed, but repository and validation tools
are removed and tool choice is forced to `none`. The model receives all prior
tool results and a full output-token budget so it can return the complete MDX
page.

Three consecutive calls with the same tool name and canonical arguments are
treated as a repeated-call loop. The third and later calls are skipped. If the
terminal iteration still does not produce final page text, the result is
`agent_loop_exhausted` and the bounded writer-attempt pipeline retries the page
with focused feedback.
