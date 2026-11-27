// @vitest-environment jsdom
import { describe, expect, test } from "vitest"

import { scrubCaptureResult } from "~/lib/analytics/posthog-options"
import {
  maskReplayAttribute,
  REPLAY_MASK_ATTRIBUTE,
  REPLAY_MASK_TEXT_SELECTOR,
  REPLAY_SITE_CANVAS_CLASS,
  scrubReplayBatch,
} from "~/lib/analytics/replay-privacy"
import { SITE_CANVAS_CLASS } from "~/lib/dashboard/site-canvas"

function render(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

function masked(element: Element | null): boolean {
  if (!element) throw new Error("element not found")
  return element.closest(REPLAY_MASK_TEXT_SELECTOR) !== null
}

describe("replay text masking", () => {
  test("dashboard text stays readable, and sensitive regions are masked", () => {
    const body = render(`
      <nav><a id="nav" href="/dashboard/projects/p1/content">Content</a></nav>
      <h1 id="heading">Billing</h1>
      <button id="button">Start 7-day Pro trial</button>
      <div class="${REPLAY_SITE_CANVAS_CLASS}"><article><p id="docs">Install the SDK</p></article></div>
      <div class="cm-editor"><div class="cm-line" id="mdx">import x</div></div>
      <div class="ProseMirror" contenteditable="true"><p id="write">Draft</p></div>
      <code id="invite">https://doxa.so/invite/abc</code>
      <span ${REPLAY_MASK_ATTRIBUTE}><b id="email">ada@example.test</b></span>
    `)
    expect(masked(body.querySelector("#nav"))).toBe(false)
    expect(masked(body.querySelector("#heading"))).toBe(false)
    expect(masked(body.querySelector("#button"))).toBe(false)
    for (const id of ["#docs", "#mdx", "#write", "#invite", "#email"]) {
      expect(masked(body.querySelector(id)), id).toBe(true)
    }
  })

  test("the canvas class matches SiteCanvas", () => {
    expect(REPLAY_SITE_CANVAS_CLASS).toBe(SITE_CANVAS_CLASS)
  })
})

describe("replay attributes", () => {
  test("text attributes are masked only inside a masked region", () => {
    const body = render(`
      <button id="plain" title="Open settings">x</button>
      <div class="${REPLAY_SITE_CANVAS_CLASS}"><img id="docs-img" alt="Architecture diagram" /></div>
    `)
    expect(maskReplayAttribute("title", "Open settings", body.querySelector("#plain") ?? undefined)).toBe("Open settings")
    expect(maskReplayAttribute("alt", "Architecture diagram", body.querySelector("#docs-img") ?? undefined)).toBe("********************")
  })

  test("links lose tokens, and other URLs stay as they are", () => {
    const body = render(`
      <a id="invite" href="x"></a>
      <a id="anchor" href="x"></a>
      <link id="font" rel="stylesheet" href="x" />
    `)
    const invite = body.querySelector("#invite") ?? undefined
    expect(maskReplayAttribute("href", "https://doxa.so/invite/abc?token=t#top", invite)).toBe("https://doxa.so/invite/:token#top")
    expect(maskReplayAttribute("href", "/dashboard/projects/p1/content?page=/intro", invite)).toBe("/dashboard/projects/p1/content")
    expect(maskReplayAttribute("href", "#install", body.querySelector("#anchor") ?? undefined)).toBe("#install")
    const fontUrl = "https://fonts.googleapis.com/css2?family=Inter"
    expect(maskReplayAttribute("href", fontUrl, body.querySelector("#font") ?? undefined)).toBe(fontUrl)
    expect(maskReplayAttribute("class", "flex", invite)).toBe("flex")
  })
})

describe("replay batches", () => {
  test("PRODUCTION INCIDENT REGRESSION GUARDRAIL: a batch on a page with a query string is kept", () => {
    // 2026-11-27: batches on the Content page (`?page=`) were dropped, so every
    // later replay frame stayed on the page before it until the next full snapshot.
    const snapshot = { uuid: "1", event: "$snapshot", properties: { $snapshot_data: [] } }
    expect(scrubCaptureResult(snapshot, "https://doxa.so/dashboard/projects/p1/content?page=/intro")).not.toBeNull()
    expect(scrubCaptureResult(snapshot, "https://doxa.so/dashboard/projects/p1/content?request=r1&review=true")).not.toBeNull()
  })

  test("a batch on a secret path is dropped", () => {
    const snapshot = { uuid: "2", event: "$snapshot", properties: {} }
    expect(scrubCaptureResult(snapshot, "https://doxa.so/invite/abc")).toBeNull()
    expect(scrubCaptureResult(snapshot, "https://doxa.so/approve/req-1")).toBeNull()
  })

  test("page addresses inside a batch lose their tokens, and DOM events are untouched", () => {
    const dom = { type: 3, data: { source: 0, adds: [] }, cv: "2024-10" }
    const batch = scrubReplayBatch({
      $session_id: "s1",
      $snapshot_data: [
        { type: 4, data: { href: "https://doxa.so/reset-password?token=abc", width: 1, height: 1 }, timestamp: 1 },
        { type: 5, data: { tag: "$url_changed", payload: { href: "https://doxa.so/dashboard?code=x" } }, timestamp: 2 },
        dom,
      ],
    })
    expect(batch).toEqual({
      $session_id: "s1",
      $snapshot_data: [
        { type: 4, data: { href: "https://doxa.so/reset-password", width: 1, height: 1 }, timestamp: 1 },
        { type: 5, data: { tag: "$url_changed", payload: { href: "https://doxa.so/dashboard" } }, timestamp: 2 },
        dom,
      ],
    })
  })
})
