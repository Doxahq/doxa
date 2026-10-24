import { PluginKey, type Transaction } from "@tiptap/pm/state"

/**
 * Stands in for `@tiptap/y-tiptap` and `@tiptap/extension-collaboration` in
 * the app build (see `config/collaboration-stub-alias.ts`).
 *
 * The block gutter's drag handle (`@tiptap/extension-drag-handle`) imports
 * both, and through them Yjs and lib0, only to keep its position right when a
 * Yjs collaboration plugin rebuilds the document. The editor has no
 * collaboration plugin, and the drag handle takes that path only when one is
 * there:
 *
 * - `getRelativePos` and `getAbsolutePos` return early when
 *   `ySyncPluginKey.getState(state)` is empty. Only the Yjs sync plugin fills
 *   that state.
 * - `isChangeOrigin(tr)` is `!!tr.getMeta(ySyncPluginKey)`. Only the Yjs sync
 *   plugin sets that meta.
 *
 * So the drag handle never calls the position converters here, and every
 * transaction takes its plain ProseMirror mapping path, as it does today.
 * Adding the Collaboration extension needs the real packages back: remove the
 * alias first.
 */

/** No plugin uses this key, so its state is always empty. */
export const ySyncPluginKey = new PluginKey("y-sync")

/** The same test as the real one. Without the Yjs sync plugin it is always false. */
export function isChangeOrigin(transaction: Transaction): boolean {
  return !!transaction.getMeta(ySyncPluginKey)
}

export function absolutePositionToRelativePosition(): never {
  throw new Error(COLLABORATION_REMOVED)
}

export function relativePositionToAbsolutePosition(): never {
  throw new Error(COLLABORATION_REMOVED)
}

const COLLABORATION_REMOVED =
  "Yjs collaboration is not part of the Doxa editor build. Remove the collaboration stub alias to use it."
