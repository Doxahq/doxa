import { scrubAnalyticsUrl } from "@doxahq/analytics/browser"

/**
 * What session replays hide. Replays show the dashboard and website text, so
 * a replay reads like the page. They hide only sensitive text: what people
 * type (`maskAllInputs`), the text of their docs and code, secrets such as
 * invite links, email addresses and payment details. The Privacy Policy
 * ("Product analytics") promises the inputs, docs and code part.
 */

/** The attribute that hides an element's text, and its descendants' text, in replays. */
export const REPLAY_MASK_ATTRIBUTE = "data-replay-mask"

/** Spread on an element whose text is sensitive: `<span {...REPLAY_MASK_PROPS}>{email}</span>`. */
export const REPLAY_MASK_PROPS: Readonly<Record<typeof REPLAY_MASK_ATTRIBUTE, "">> = { [REPLAY_MASK_ATTRIBUTE]: "" }

/**
 * The class of `SiteCanvas`, which draws every docs page in the dashboard:
 * the Write editor, the Split preview and the review preview. Kept as a
 * literal so this module does not load the theme code; a test checks that it
 * matches `SITE_CANVAS_CLASS`.
 */
export const REPLAY_SITE_CANVAS_CLASS = "doxa-site-canvas"

/**
 * Text under any of these selectors is masked. rrweb also checks ancestors,
 * so one selector covers a whole editor or preview.
 */
export const REPLAY_MASK_SELECTORS: readonly string[] = [
  `[${REPLAY_MASK_ATTRIBUTE}]`,
  // Rendered docs pages.
  `.${REPLAY_SITE_CANVAS_CLASS}`,
  // Editors: CodeMirror (MDX source, diffs, JSON) and TipTap (Write mode).
  ".cm-editor",
  ".ProseMirror",
  '[contenteditable="true"]',
  "textarea",
  // Code, snippets and single-use links (an invite link is a <code>).
  "pre",
  "code",
  "samp",
]

export const REPLAY_MASK_TEXT_SELECTOR = REPLAY_MASK_SELECTORS.join(", ")

/** Attributes that repeat an element's text, masked when the element's text is masked. */
const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(["title", "alt", "aria-label", "aria-description", "placeholder"])

/** Elements whose URL attribute is a link that a person follows. Stylesheet and font URLs stay as they are, so replays keep their styles. */
const LINK_ATTRIBUTES: Readonly<Record<string, string>> = { a: "href", area: "href", form: "action" }

/**
 * rrweb's `maskAttributeFn`: runs on every recorded attribute. Text
 * attributes inside a masked element become asterisks, and links lose their
 * tokens (`/invite/…`, `?token=`).
 */
export function maskReplayAttribute(name: string, value: string, element?: Element): string {
  if (!element || value === "") return value
  if (TEXT_ATTRIBUTES.has(name) && isReplayMasked(element)) return "*".repeat(value.length)
  if (LINK_ATTRIBUTES[element.tagName.toLowerCase()] === name && isLinkUrl(value)) return scrubLink(value)
  return value
}

function isReplayMasked(element: Element): boolean {
  try {
    return element.closest(REPLAY_MASK_TEXT_SELECTOR) !== null
  } catch {
    return true
  }
}

/** An absolute URL or a root-relative path. A fragment link (`#install`) holds no secret. */
function isLinkUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("/")
}

/** Scrubs a link but keeps its fragment, which never reaches a server and names only a heading. */
function scrubLink(value: string): string {
  const hashIndex = value.indexOf("#")
  const fragment = hashIndex === -1 ? "" : value.slice(hashIndex)
  const scrubbed = scrubAnalyticsUrl(hashIndex === -1 ? value : value.slice(0, hashIndex))
  return scrubbed === "" ? value : `${scrubbed}${fragment}`
}

/** rrweb event types that carry the page address. */
const RRWEB_META_EVENT = 4
const RRWEB_CUSTOM_EVENT = 5

/**
 * Removes secrets from the page addresses in a replay batch. rrweb writes the
 * raw `window.location.href` into each Meta event, and posthog-js writes
 * `$pageview` and `$url_changed` custom events (already scrubbed through
 * `maskCapturedNetworkRequestFn`, scrubbed again here). The DOM data is
 * compressed by then, so `maskReplayAttribute` handles the DOM when it is
 * recorded.
 */
export function scrubReplayBatch(properties: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const data = properties.$snapshot_data
  if (!Array.isArray(data)) return { ...properties }
  return { ...properties, $snapshot_data: data.map(scrubReplayEvent) }
}

function scrubReplayEvent(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.data)) return event
  if (event.type === RRWEB_META_EVENT && typeof event.data.href === "string") {
    return { ...event, data: { ...event.data, href: scrubAnalyticsUrl(event.data.href) } }
  }
  const payload = event.data.payload
  if (event.type === RRWEB_CUSTOM_EVENT && isRecord(payload) && typeof payload.href === "string") {
    return { ...event, data: { ...event.data, payload: { ...payload, href: scrubAnalyticsUrl(payload.href) } } }
  }
  return event
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
