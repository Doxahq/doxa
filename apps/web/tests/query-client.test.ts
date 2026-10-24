import { QueryClient, environmentManager } from "@tanstack/react-query"
import { afterEach, describe, expect, test } from "vitest"

import { getQueryClient } from "~/lib/query-client"

afterEach(() => {
  environmentManager.setIsServer(() => typeof window === "undefined")
})

describe("getQueryClient", () => {
  // One person's cached data must never reach another person's page.
  test("the server gets a new client for each request", () => {
    environmentManager.setIsServer(() => true)
    const first = getQueryClient()
    const second = getQueryClient()
    expect(first).toBeInstanceOf(QueryClient)
    expect(second).not.toBe(first)
  })

  test("the browser keeps one client for the whole visit", () => {
    environmentManager.setIsServer(() => false)
    expect(getQueryClient()).toBe(getQueryClient())
  })

  test("a server client never is the browser client", () => {
    environmentManager.setIsServer(() => false)
    const browser = getQueryClient()
    environmentManager.setIsServer(() => true)
    expect(getQueryClient()).not.toBe(browser)
  })

  test("clients keep the dashboard defaults", () => {
    environmentManager.setIsServer(() => true)
    expect(getQueryClient().getDefaultOptions().queries).toMatchObject({
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    })
  })
})
