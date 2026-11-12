import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { readDnsHostChoice, writeDnsHostChoice } from "~/lib/dashboard/dns-host-choice"
import { stubMemoryLocalStorage } from "./support/memory-storage"

beforeEach(() => {
  stubMemoryLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("dns host choice storage", () => {
  test("saves a choice per domain", () => {
    writeDnsHostChoice("domain-1", "namecheap")
    writeDnsHostChoice("domain-2", "other")
    expect(readDnsHostChoice("domain-1")).toBe("namecheap")
    expect(readDnsHostChoice("domain-2")).toBe("other")
    expect(readDnsHostChoice("domain-3")).toBeNull()
  })

  test("null removes the choice", () => {
    writeDnsHostChoice("domain-1", "godaddy")
    writeDnsHostChoice("domain-1", null)
    expect(readDnsHostChoice("domain-1")).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  test("ignores a stored value that is not a guide id", () => {
    localStorage.setItem("doxa:dns-host-choice:domain-1", "bluehost")
    expect(readDnsHostChoice("domain-1")).toBeNull()
  })

  test("survives storage that throws", () => {
    const blocked = (): never => {
      throw new Error("blocked")
    }
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked })
    expect(() => writeDnsHostChoice("domain-1", "vercel")).not.toThrow()
    expect(() => writeDnsHostChoice("domain-1", null)).not.toThrow()
    expect(readDnsHostChoice("domain-1")).toBeNull()
  })
})
