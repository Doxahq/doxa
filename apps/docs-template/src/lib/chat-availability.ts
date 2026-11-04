/** The part of a site's features that decides whether chat is offered. */
export interface ChatFeatureFlags {
  ai: { chat: boolean };
}

/**
 * True when the site turns chat on and this build can answer it. The platform
 * renderer build (`DOXA_OMIT_LOCAL_CONTENT_SOURCE`) has no chat assistant, so
 * it never draws chat controls that would only fail. The template's own build
 * keeps chat.
 */
export function isChatAvailable(
  features: ChatFeatureFlags,
  omitsLocalContent: boolean = import.meta.env
    .DOXA_OMIT_LOCAL_CONTENT_SOURCE === true
): boolean {
  return features.ai.chat && !omitsLocalContent;
}
