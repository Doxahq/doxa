import type { ReactNode } from "react"
import type { IconComponent } from "@doxahq/docs-prose"
import { DocsIconSvg, docsIconKey } from "@doxahq/docs-prose/icons"

import { DEFAULT_DOCS_PAGE_ICON, useDocsIconNode } from "~/lib/dashboard/docs-icons"

/**
 * A docs icon by any Lucide name, drawn as the published site draws it.
 *
 * While the full icon set loads, it keeps an empty frame of the same size,
 * so nothing moves when the glyph appears. A name that is no icon draws the
 * fallback.
 */
export function DocsIcon({
  name,
  className,
  strokeWidth,
  fallback = null,
}: {
  name: string | null | undefined
  className?: string
  strokeWidth?: number
  fallback?: ReactNode
}) {
  const node = useDocsIconNode(name)
  if (node === null) return fallback
  return <DocsIconSvg node={node} className={className} strokeWidth={strokeWidth} />
}

/** A page's icon in the content lists, or the plain page glyph when it has none. */
export function DocsPageIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  return <DocsIcon name={name} className={className} fallback={<DEFAULT_DOCS_PAGE_ICON aria-hidden="true" className={className} />} />
}

const cardIcons = new Map<string, IconComponent>()

/**
 * The card icon component for a name, for `createCard` and the MDX preview.
 * The same name always gets the same component, so a card keeps its icon
 * across renders.
 */
export function resolveDocsIcon(name: string): IconComponent | null {
  const key = docsIconKey(name)
  if (!key) return null
  let component = cardIcons.get(key)
  if (!component) {
    component = function CardIcon({ className }: { className?: string }) {
      return <DocsIcon name={key} className={className} />
    }
    cardIcons.set(key, component)
  }
  return component
}
