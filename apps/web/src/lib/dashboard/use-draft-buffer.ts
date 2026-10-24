import { useCallback, useEffect, useRef, useState } from "react"

/** Idle delay before an unsaved buffer is written to the working branch. */
export const DRAFT_AUTOSAVE_DELAY_MS = 1_200

/** The persisted value for one key, as the server holds it. */
export interface DraftBufferSource<TValue> {
  key: string
  value: TValue
}

export interface UseDraftBufferOptions<TValue> {
  /**
   * The loaded value. The buffer takes it once per key, so an editor that
   * returns to a key continues where it stopped. Pass a stable object.
   */
  source: DraftBufferSource<TValue> | null
  /** Persists one value to the working branch. Throw to report a failed save. */
  save: (value: TValue, key: string) => Promise<void>
  isEqual?: (left: TValue, right: TValue) => boolean
  /** A value that fails this check is kept local: no autosave, no flush. */
  canSave?: (value: TValue) => boolean
  delayMs?: number
}

export interface DraftBuffer<TValue> {
  key: string | null
  value: TValue | null
  setValue: (value: TValue) => void
  /** Derives the next value from the latest one, even within one event. */
  update: (recipe: (value: TValue) => TValue) => void
  isDirty: boolean
  /** Saves a dirty value now. Resolves false when the value was not saved. */
  flush: () => Promise<boolean>
  cancelAutosave: () => void
  /** Drops the buffer, so the next source loads fresh. */
  reset: () => void
  /**
   * Moves the buffer to a new key and keeps its text, for a value that the
   * server stored under a new key (a renamed page). A source with the new key
   * then finds the buffer already loaded.
   */
  rekey: (from: string, to: string) => void
  /** Drops the buffer until the returned function restores it. */
  suspend: () => () => void
  /** Resolves when every queued save has finished. */
  waitForPendingSaves: () => Promise<void>
}

interface BufferState<TValue> {
  key: string
  /** What the editor shows right now. */
  value: TValue
  /** What the working branch holds, so unsaved work is detectable. */
  saved: TValue
}

/**
 * An editable copy of one persisted value, with autosave.
 *
 * The timer restarts on every change, so only an idle value is written. Saves
 * run one at a time in a queue, so a slow request cannot overwrite a newer one.
 */
export function useDraftBuffer<TValue>({
  source,
  save,
  isEqual = Object.is,
  canSave,
  delayMs = DRAFT_AUTOSAVE_DELAY_MS,
}: UseDraftBufferOptions<TValue>): DraftBuffer<TValue> {
  const [buffer, setBuffer] = useState<BufferState<TValue> | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest callbacks, read at save time. The caller does not need to
  // memoize them, and a queued save always uses the current save function.
  const saveRef = useRef(save)
  const isEqualRef = useRef(isEqual)
  const canSaveRef = useRef(canSave)
  saveRef.current = save
  isEqualRef.current = isEqual
  canSaveRef.current = canSave

  useEffect(() => {
    if (!source) return
    setBuffer((current) =>
      current?.key === source.key
        ? current
        : { key: source.key, value: source.value, saved: source.value },
    )
  }, [source])

  const isDirty = buffer !== null && !isEqual(buffer.value, buffer.saved)

  const flush = useCallback((): Promise<boolean> => {
    const snapshot = buffer
    const operation = saveQueueRef.current.then(async () => {
      if (!snapshot || isEqualRef.current(snapshot.value, snapshot.saved)) return true
      if (canSaveRef.current && !canSaveRef.current(snapshot.value)) return false
      const { key, value } = snapshot

      try {
        await saveRef.current(value, key)
      } catch {
        return false
      }

      setBuffer((current) => (current && current.key === key ? { ...current, saved: value } : current))
      return true
    })
    saveQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }, [buffer])

  const flushRef = useRef(flush)
  flushRef.current = flush
  const cancelAutosave = useCallback(() => {
    if (autosaveTimerRef.current === null) return
    clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = null
  }, [])

  useEffect(() => {
    cancelAutosave()
    if (!isDirty) return
    const timer = setTimeout(() => {
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null
      void flushRef.current()
    }, delayMs)
    autosaveTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null
    }
  }, [cancelAutosave, delayMs, isDirty, buffer?.value])

  const setValue = useCallback((value: TValue) => {
    setBuffer((current) => (current ? { ...current, value } : current))
  }, [])

  const update = useCallback((recipe: (value: TValue) => TValue) => {
    setBuffer((current) => (current ? { ...current, value: recipe(current.value) } : current))
  }, [])

  const reset = useCallback(() => {
    cancelAutosave()
    setBuffer(null)
  }, [cancelAutosave])

  const rekey = useCallback((from: string, to: string) => {
    setBuffer((current) => (current?.key === from ? { ...current, key: to } : current))
  }, [])

  const suspend = useCallback(() => {
    const suspended = buffer
    cancelAutosave()
    setBuffer(null)
    return () => setBuffer((current) => current ?? suspended)
  }, [buffer, cancelAutosave])

  // A stable function that reads the latest flush, for callers that store it.
  const stableFlush = useCallback(() => flushRef.current(), [])
  const waitForPendingSaves = useCallback(() => saveQueueRef.current, [])

  return {
    key: buffer?.key ?? null,
    value: buffer?.value ?? null,
    setValue,
    update,
    isDirty,
    flush: stableFlush,
    cancelAutosave,
    reset,
    rekey,
    suspend,
    waitForPendingSaves,
  }
}
