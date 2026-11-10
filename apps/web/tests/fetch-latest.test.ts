import { QueryClient } from "@tanstack/react-query"
import { describe, expect, test } from "vitest"

import { fetchLatest } from "~/lib/queries/fetch-latest"

const KEY = ["page"] as const

/** Answers with `first` in order, then always with `last`. */
function answers(first: Promise<string>[], last: string) {
  const queue = [...first]
  return () => queue.shift() ?? Promise.resolve(last)
}

describe("fetchLatest", () => {
  test("joins the newer refresh when the refresh that it shares is cancelled", async () => {
    const neverAnswers = new Promise<string>(() => undefined)
    const queryFn = answers([Promise.resolve("old"), neverAnswers], "new")
    const client = new QueryClient()
    await client.fetchQuery({ queryKey: KEY, queryFn })

    void client.refetchQueries({ queryKey: KEY })
    const read = fetchLatest(client, { queryKey: KEY, queryFn })
    void client.refetchQueries({ queryKey: KEY })

    await expect(read).resolves.toBe("new")
  })

  test("reads again when the cached data is fresh", async () => {
    const queryFn = answers([Promise.resolve("old")], "new")
    const client = new QueryClient()
    await client.fetchQuery({ queryKey: KEY, queryFn, staleTime: Number.POSITIVE_INFINITY })

    await expect(fetchLatest(client, { queryKey: KEY, queryFn })).resolves.toBe("new")
  })

  test("gives null when the request fails", async () => {
    const queryFn = () => Promise.reject<string>(new Error("The API is down."))

    await expect(fetchLatest(new QueryClient(), { queryKey: KEY, queryFn })).resolves.toBeNull()
  })
})
