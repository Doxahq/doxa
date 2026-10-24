import { afterEach, describe, expect, test, vi } from "vitest"

import {
  ApiRequestError,
  ApiValidationError,
  createApiError,
} from "~/lib/api-errors"
import { applyProjectContentEdits, getApiUrl } from "~/lib/platform-api"
import { uploadSiteAsset } from "~/lib/site-assets-api"

const issue = {
  path: "/navbar/links/0/href",
  code: "invalid_href",
  severity: "error",
  message: "This link is not valid.",
} as const

describe("API errors", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("a 422 body with issues becomes an ApiValidationError", () => {
    const error = createApiError(422, {
      error: {
        message: "The site settings have 1 errors.",
        details: { code: "validation_failed", issues: [issue] },
      },
    })
    expect(error).toBeInstanceOf(ApiValidationError)
    expect(error).toMatchObject({
      message: "The site settings have 1 errors.",
      status: 422,
      code: "validation_failed",
      issues: [issue],
    })
  })

  test("a detail code without issues stays an ApiRequestError with that code", () => {
    const error = createApiError(409, {
      error: { message: "The published documentation changed.", details: { code: "branch_behind" } },
    })
    expect(error).not.toBeInstanceOf(ApiValidationError)
    expect(error).toMatchObject({ status: 409, code: "branch_behind" })
  })

  test("malformed issues do not become a validation error", () => {
    const error = createApiError(422, {
      error: { message: "Bad", details: { code: "validation_failed", issues: [{ path: 1 }] } },
    })
    expect(error).not.toBeInstanceOf(ApiValidationError)
    expect(error.message).toBe("Bad")
  })

  test.each([
    [{ error: "Plain message" }, "Plain message"],
    [{ error: { details: {} } }, "Request failed (500)"],
    [null, "Request failed (500)"],
    ["<html>", "Request failed (500)"],
  ])("keeps the readable message for %j", (payload, message) => {
    const error = createApiError(500, payload)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error.message).toBe(message)
  })

  test("apiFetch callers receive the typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "1 error", details: { code: "validation_failed", issues: [issue] } } },
          { status: 422 },
        ),
      ),
    )
    await expect(
      applyProjectContentEdits("project-1", { edits: [{ type: "reset_site_config" }] }),
    ).rejects.toBeInstanceOf(ApiValidationError)
  })
})

describe("site asset upload", () => {
  afterEach(() => vi.unstubAllGlobals())

  test("posts the kind and the file as multipart form data", async () => {
    const ref = `asset:${"a".repeat(64)}`
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ ref, contentType: "image/png", size: 3 }, { status: 201 }),
    )
    vi.stubGlobal("fetch", fetch)

    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    await expect(uploadSiteAsset("project 1", "logo", file)).resolves.toEqual({
      ref,
      contentType: "image/png",
      size: 3,
    })

    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe(getApiUrl("/projects/project%201/assets"))
    expect(init?.method).toBe("POST")
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    if (body instanceof FormData) {
      expect(body.get("kind")).toBe("logo")
      expect(body.get("file")).toBeInstanceOf(Blob)
    }
    // The browser sets the multipart boundary. A manual content type breaks it.
    expect(new Headers(init?.headers).has("content-type")).toBe(false)
  })

  test("rejects a response that does not match the upload contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ref: "https://evil.example/x.png" })))
    await expect(
      uploadSiteAsset("project-1", "logo", new Blob(["x"])),
    ).rejects.toThrow()
  })
})
