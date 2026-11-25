/**
 * The AI assistant settings (`features.ai`) stay hidden until chat works on
 * published sites and follows billing and the account's plan. Today the
 * platform renderer has no chat assistant (`isChatAvailable` in the docs
 * template), so these toggles change nothing that readers see. The schema
 * keeps all three off by default, and the JSON tab can still edit them.
 *
 * The Features tab and its loading skeleton both read this flag, so the
 * skeleton keeps the page's shape.
 */
export const SHOW_AI_ASSISTANT_SETTINGS = false
