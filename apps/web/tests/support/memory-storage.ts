import { vi } from "vitest"

/**
 * An in-memory `localStorage`. Node 25+ defines its own `localStorage`
 * global, which is undefined without `--localstorage-file` and hides the
 * jsdom one. Call it in `beforeEach` and undo it with `vi.unstubAllGlobals()`.
 */
export function stubMemoryLocalStorage(): Storage {
  const values = new Map<string, string>()
  const storage: Storage = {
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
      values.set(key, String(value))
    },
  }
  vi.stubGlobal("localStorage", storage)
  return storage
}
