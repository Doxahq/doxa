import { describe, expect, test } from "vitest"

import { ANALYTICS_CONSENT_STORAGE_KEY, createConsentStore } from "~/lib/analytics/consent-store"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

function throwingStorage(): Storage {
  const fail = () => {
    throw new DOMException("blocked", "SecurityError")
  }
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail }
}

describe("analytics consent store", () => {
  test("no choice until the visitor makes one, then the stored choice", () => {
    const storage = memoryStorage()
    const store = createConsentStore(() => storage)
    expect(store.read()).toBeNull()
    store.write("granted")
    expect(storage.getItem(ANALYTICS_CONSENT_STORAGE_KEY)).toBe("granted")
    expect(store.read()).toBe("granted")
    store.write("denied")
    expect(store.read()).toBe("denied")
  })

  test("a value that this code did not write reads as no choice", () => {
    const storage = memoryStorage()
    storage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, "yes")
    expect(createConsentStore(() => storage).read()).toBeNull()
  })

  test("blocked storage never throws: reads as no choice and drops writes", () => {
    const blocked = createConsentStore(() => throwingStorage())
    expect(blocked.read()).toBeNull()
    expect(() => blocked.write("granted")).not.toThrow()
    const getterThrows = createConsentStore(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    expect(getterThrows.read()).toBeNull()
    expect(() => getterThrows.write("denied")).not.toThrow()
    const server = createConsentStore(() => null)
    expect(server.read()).toBeNull()
  })
})
