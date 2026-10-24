import { describe, expect, test } from "vitest"

import { assertSafeProductionEnv, findUnsafeProductionEnv } from "../config/production-env"

const productionEnv = {
  VITE_API_BASE_URL: "https://api.doxa.so",
  VITE_DOCS_BASE_DOMAIN: "doxa.page",
  VITE_DOCS_RENDERER_BASE_URL: "",
  VITE_DOCS_RUNTIME_URL: "https://preview.doxa.so",
}

describe("production build environment", () => {
  test("accepts production values and an empty renderer base URL", () => {
    expect(findUnsafeProductionEnv(productionEnv)).toEqual([])
    expect(() => assertSafeProductionEnv(productionEnv)).not.toThrow()
  })

  test.each([
    ["VITE_DOCS_RENDERER_BASE_URL", "http://localhost:3002"],
    ["VITE_DOCS_RUNTIME_URL", "http://localhost:8788"],
    ["VITE_API_BASE_URL", "http://127.0.0.1:8787"],
    ["VITE_API_BASE_URL", "https://dev.doxa.so"],
  ])("rejects a development %s from .env.local", (key, value) => {
    expect(findUnsafeProductionEnv({ ...productionEnv, [key]: value })).toEqual([
      `${key} points to a development address (${value}).`,
    ])
  })

  test("rejects the development auth bypass", () => {
    expect(() =>
      assertSafeProductionEnv({ ...productionEnv, VITE_DEV_USER_ID: "local-dev-user" }),
    ).toThrow(/VITE_DEV_USER_ID is a development-only setting/)
  })

  test("ignores variables outside the client bundle", () => {
    expect(findUnsafeProductionEnv({ DATABASE_URL: "postgres://localhost:5432/doxa" })).toEqual([])
  })
})
