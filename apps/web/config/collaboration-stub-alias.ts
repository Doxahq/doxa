import { fileURLToPath } from "node:url"

const stub = fileURLToPath(new URL("../src/lib/editor/collaboration-stub.ts", import.meta.url))

/**
 * Replaces the Yjs collaboration packages that the block gutter's drag handle
 * imports with a small stub, so Yjs and lib0 stay out of the editor bundle.
 * The editor has no collaboration, and without it the drag handle never uses
 * them. `src/lib/editor/collaboration-stub.ts` explains why that is safe.
 */
export const collaborationStubAlias = [
  { find: /^@tiptap\/y-tiptap$/, replacement: stub },
  { find: /^@tiptap\/extension-collaboration$/, replacement: stub },
]
