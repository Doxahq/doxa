// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import {
  DRAFT_AUTOSAVE_DELAY_MS,
  useDraftBuffer,
  type DraftBufferSource,
  type UseDraftBufferOptions,
} from "~/lib/dashboard/use-draft-buffer"

type Options = UseDraftBufferOptions<string>

function renderBuffer(initial: Options) {
  return renderHook((options: Options) => useDraftBuffer(options), { initialProps: initial })
}

function source(key: string, value: string): DraftBufferSource<string> {
  return { key, value }
}

describe("useDraftBuffer", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("loads a source once per key and keeps edits when the same key reloads", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", "one"), save })
    act(() => hook.result.current.setValue("edited"))

    hook.rerender({ source: source("a", "server copy"), save })
    expect(hook.result.current.value).toBe("edited")

    hook.rerender({ source: source("b", "two"), save })
    expect(hook.result.current).toMatchObject({ key: "b", value: "two", isDirty: false })
  })

  test("replace drops unsaved edits and stops their autosave", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", "one"), save })
    act(() => hook.result.current.setValue("my words"))
    expect(hook.result.current.saved).toBe("one")
    act(() => hook.result.current.replace("a", "newer"))
    expect(hook.result.current).toMatchObject({ value: "newer", saved: "newer", isDirty: false })
    act(() => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS))
    expect(save).not.toHaveBeenCalled()
  })

  test("replaceClean loads a newer value in place, with no empty state", () => {
    const hook = renderBuffer({ source: source("a", "one"), save: vi.fn(async () => undefined) })
    act(() => hook.result.current.replaceClean("a", "newer"))
    expect(hook.result.current.value).toBe("newer")
    expect(hook.result.current.isDirty).toBe(false)
  })

  test("replaceClean keeps edits typed before it runs, and ignores another key", () => {
    const hook = renderBuffer({ source: source("a", "one"), save: vi.fn(async () => undefined) })
    act(() => {
      // The same batch: the edit is not in the hook's last render yet.
      hook.result.current.setValue("my words")
      hook.result.current.replaceClean("a", "newer")
    })
    expect(hook.result.current.value).toBe("my words")
    act(() => hook.result.current.replaceClean("b", "other"))
    expect(hook.result.current.value).toBe("my words")
  })

  test("autosaves only after the idle delay, and each change restarts the timer", async () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", ""), save })

    act(() => hook.result.current.setValue("x"))
    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS - 1))
    act(() => hook.result.current.setValue("xy"))
    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS - 1))
    expect(save).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTime(1))
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith("xy", "a")
    expect(hook.result.current.isDirty).toBe(false)
  })

  test("flush saves at once and reports success", async () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", ""), save })
    act(() => hook.result.current.setValue("now"))

    let saved = false
    await act(async () => {
      saved = await hook.result.current.flush()
    })
    expect(saved).toBe(true)
    expect(save).toHaveBeenCalledWith("now", "a")
    expect(hook.result.current.isDirty).toBe(false)
  })

  test("a failed save reports false and keeps the value dirty", async () => {
    const save = vi.fn(async () => {
      throw new Error("offline")
    })
    const hook = renderBuffer({ source: source("a", ""), save })
    act(() => hook.result.current.setValue("lost?"))

    let saved = true
    await act(async () => {
      saved = await hook.result.current.flush()
    })
    expect(saved).toBe(false)
    expect(hook.result.current).toMatchObject({ value: "lost?", isDirty: true })
  })

  test("a value that fails canSave stays local", async () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({
      source: source("a", "{}"),
      save,
      canSave: (value) => value.startsWith("{"),
    })
    act(() => hook.result.current.setValue("not json"))
    await act(async () => vi.advanceTimersByTime(DRAFT_AUTOSAVE_DELAY_MS * 2))

    let saved = true
    await act(async () => {
      saved = await hook.result.current.flush()
    })
    expect(saved).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })

  test("saves run one at a time, in order", async () => {
    const events: string[] = []
    let release: () => void = () => undefined
    const firstSaveGate = new Promise<void>((resolve) => (release = resolve))
    const save = vi.fn(async (value: string) => {
      events.push(`start ${value}`)
      if (value === "first") await firstSaveGate
      events.push(`end ${value}`)
    })
    const hook = renderBuffer({ source: source("a", ""), save })

    act(() => hook.result.current.setValue("first"))
    let first: Promise<boolean> = Promise.resolve(true)
    act(() => {
      first = hook.result.current.flush()
    })
    act(() => hook.result.current.setValue("second"))
    let second: Promise<boolean> = Promise.resolve(true)
    act(() => {
      second = hook.result.current.flush()
    })

    await act(async () => {
      release()
      await Promise.all([first, second])
    })
    expect(events).toEqual(["start first", "end first", "start second", "end second"])
  })

  test("update applies each recipe to the latest value", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", ""), save })
    act(() => {
      hook.result.current.update((value) => `${value}a`)
      hook.result.current.update((value) => `${value}b`)
    })
    expect(hook.result.current.value).toBe("ab")
  })

  test("suspend drops the buffer until restore", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", ""), save })
    act(() => hook.result.current.setValue("kept"))

    let restore: () => void = () => undefined
    act(() => {
      restore = hook.result.current.suspend()
    })
    expect(hook.result.current.value).toBeNull()

    act(() => restore())
    expect(hook.result.current.value).toBe("kept")
  })

  test("rekey moves the buffer with its text, so the source under the new key does not reload it", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", "one"), save })
    act(() => hook.result.current.setValue("typed"))

    act(() => hook.result.current.rekey("a", "b"))
    hook.rerender({ source: source("b", "server copy"), save })

    expect(hook.result.current).toMatchObject({ key: "b", value: "typed", isDirty: true })
  })

  test("rekey ignores a buffer under another key", () => {
    const save = vi.fn(async () => undefined)
    const hook = renderBuffer({ source: source("a", "one"), save })
    act(() => hook.result.current.rekey("other", "b"))
    expect(hook.result.current.key).toBe("a")
  })
})
