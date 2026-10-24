import { useState, type ReactNode } from "react"
import { CardGrid, createCard, createProseComponents, RuntimeMdxContent, type ProseLinkProps } from "@doxahq/docs-prose"
import { parseRuntimeMdx, type RuntimeMdxNode } from "@doxahq/mdx-runtime"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { ArrowUpRight, Plus, Trash2, X } from "lucide-react"

import { PropsForm } from "~/components/dashboard/content/write-editor/props-form"
import { Popover, PopoverAnchor, PopoverContent } from "~/components/ui/popover"
import { resolveDocsIcon } from "~/components/dashboard/content/docs-icon"
import { CARD_PROPS, readProp, writeProp, type PropField, type PropValue } from "~/lib/editor/component-props"
import { releaseBlockSelection } from "~/lib/editor/block-selection"
import type { MdxCard } from "~/lib/editor/mdx-document"
import { cn } from "~/lib/utils"

/**
 * The card's link, without navigation. It keeps the anchor, so the prose link
 * rules style the card as they do on the site, but it has no `href`: a click
 * opens the card's settings instead of leaving the editor. On the site the
 * anchor is the grid item. Here it sits in one, so it fills it.
 */
function EditorCardLink({ className, children }: ProseLinkProps) {
  return <a className={`${className ?? ""} block h-full`}>{children}</a>
}

/** The published card, drawn with the dashboard's copy of the same Lucide glyphs. */
const EditorCard = createCard({ link: EditorCardLink, resolveIcon: resolveDocsIcon, ExternalIcon: ArrowUpRight })

/** The site's grid, or the loose cards the site draws one under another. */
function Grid({ grid, children }: { grid: boolean; children: ReactNode }) {
  return grid ? <CardGrid>{children}</CardGrid> : <div className="flex flex-col gap-4 sm:gap-6">{children}</div>
}

const NEW_CARD: MdxCard = { attributes: [{ name: "title", value: "Card title" }], body: "Describe this card." }

/**
 * Card group: the published `<CardGrid>` of `<Card>`s. A click on a card opens
 * its settings. The settings popover is a portal, so it keeps the dashboard
 * look, while the cards take the site's.
 */
export function CardGroupView({ node, updateAttributes, deleteNode, editor, selected }: ReactNodeViewProps) {
  const cards = (node.attrs.cards ?? []) as MdxCard[]
  const editable = editor.isEditable
  // Cards written without a `<CardGrid>` are drawn without one, full width.
  const grid = node.attrs.grid !== false
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  function setCards(next: MdxCard[]) {
    updateAttributes({ cards: next })
  }

  return (
    // While one card's settings are open, that card carries the outline.
    <NodeViewWrapper className="doxa-card-group" data-selected={(selected && openIndex === null) || undefined}>
      <div contentEditable={false}>
        <Grid grid={grid}>
          {cards.map((card, index) => (
            <CardEditor
              key={index}
              card={card}
              editable={editable}
              open={openIndex === index}
              onOpenChange={(open) => {
                // The open card has the outline now. A block selected before lets go.
                if (open) releaseBlockSelection(editor)
                setOpenIndex(open ? index : null)
              }}
              onChange={(next) => setCards(cards.map((current, position) => (position === index ? next : current)))}
              onRemove={() => {
                setOpenIndex(null)
                // A group with no cards left is removed, not saved empty.
                if (cards.length === 1) deleteNode()
                else setCards(cards.filter((_, position) => position !== index))
              }}
            />
          ))}
        </Grid>
        {editable && grid ? (
          <button
            type="button"
            onClick={() => {
              setCards([...cards, NEW_CARD])
              setOpenIndex(cards.length)
            }}
            className="not-prose mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="size-4" />
            Add card
          </button>
        ) : null}
      </div>
    </NodeViewWrapper>
  )
}

function CardEditor({
  card,
  editable,
  open,
  onOpenChange,
  onChange,
  onRemove,
}: {
  card: MdxCard
  editable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (card: MdxCard) => void
  onRemove: () => void
}) {
  const props = cardProps(card)
  return (
    <Popover open={open && editable} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          role={editable ? "button" : undefined}
          tabIndex={editable ? 0 : undefined}
          aria-label={editable ? `Edit card ${props.title || "without a title"}` : undefined}
          onClick={() => editable && onOpenChange(true)}
          onKeyDown={(event) => {
            if (editable && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault()
              onOpenChange(true)
            }
          }}
          className={cn(
            "relative h-full cursor-pointer",
            // The card being edited keeps an outline, so the settings point at it.
            open && editable && "outline-1 outline-dashboard-primary outline-solid",
          )}
        >
          <EditorCard {...props}>{cardBody(card)}</EditorCard>
        </div>
      </PopoverAnchor>
      {/* Above the card at its left edge, like every editor menu. It never flips: with little room it gets shorter and scrolls. */}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={16}
        avoidCollisions={false}
        aria-label="Card settings"
        className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[340px] flex-col p-0"
        onOpenAutoFocus={(event) => {
          // Focus the title field, not the popover itself.
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("input, textarea")?.focus()
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-divider py-2 pr-2 pl-4">
          <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-label uppercase">Card</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-body">{props.title || "Untitled"}</span>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove card"
            title="Remove card"
            className="grid size-7 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close card settings"
            title="Close"
            className="grid size-7 place-items-center text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </header>
        <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">
          <PropsForm
            fields={CARD_PROPS}
            read={(field) => readCardProp(card, field)}
            onChange={(field, value) => onChange(writeCardProp(card, field, value))}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The card's props, the way the renderer reads them from its attributes. */
function cardProps(card: MdxCard) {
  const get = (name: string) => card.attributes.find((attribute) => attribute.name === name)
  const text = (name: string) => get(name)?.value ?? undefined
  const external = get("external")
  return {
    title: text("title") ?? "",
    subtitle: text("subtitle"),
    description: text("description"),
    href: text("href"),
    image: text("image"),
    icon: text("icon"),
    variant: text("variant") as "normal" | "small" | "image" | undefined,
    external: external ? external.value === null || external.value === "true" : undefined,
  }
}

/** Links in a card's body do not navigate in the editor, like the card's own link. */
const BODY_COMPONENTS = createProseComponents({ link: EditorCardLink })

/**
 * The card's body, as the renderer draws it: inline for a one-line card, a
 * paragraph for a card written over several lines. Markdown in it is drawn,
 * not shown as syntax.
 */
function cardBody(card: MdxCard): ReactNode {
  if (!card.body) return null
  if (!card.markdown) return card.line !== undefined ? card.body : <p>{card.body}</p>
  let nodes: readonly RuntimeMdxNode[]
  try {
    nodes = parseRuntimeMdx(card.body).nodes
  } catch {
    return card.line !== undefined ? card.body : <p>{card.body}</p>
  }
  const [paragraph] = nodes
  const inline = card.line !== undefined && paragraph?.type === "element" && paragraph.name === "p" ? (paragraph.children ?? []) : nodes
  return <RuntimeMdxContent document={{ frontmatter: {}, nodes: [...inline] }} components={BODY_COMPONENTS} />
}

/**
 * "Description" edits the `description` attribute when the card has one, and
 * the card's body text otherwise, the same text the reader sees.
 */
function readCardProp(card: MdxCard, field: PropField): PropValue {
  if (field.name === "description" && !card.attributes.some(({ name }) => name === "description")) return card.body ?? ""
  return readProp(card.attributes, field)
}

function writeCardProp(card: MdxCard, field: PropField, value: PropValue): MdxCard {
  if (field.name === "description" && !card.attributes.some(({ name }) => name === "description")) {
    return { ...card, body: typeof value === "string" && value ? value : null }
  }
  return { ...card, attributes: writeProp(card.attributes, field, value) }
}
