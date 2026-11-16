import { CreditCard } from "lucide-react"

import type { CardBrandLogo } from "~/lib/dashboard/card-brands"
import { cn } from "~/lib/utils"

const CHIP_CLASS = "grid h-6.5 w-10 shrink-0 place-items-center overflow-hidden rounded-sm border"

/**
 * The card chip of the payment method: the brand logo at the size of a card
 * mark. A glyph sits on a white chip in its brand color, like the mark printed
 * on a card. Mastercard keeps its two colors on the dark chip. No logo shows
 * the generic card icon. The card's name is in the text next to it, so the
 * chip is decorative.
 */
export function CardBrandMark({ logo }: { logo: CardBrandLogo | null }) {
  if (logo?.kind === "glyph") {
    return (
      <span aria-hidden="true" className={cn(CHIP_CLASS, "border-white bg-white")}>
        <svg viewBox={logo.viewBox} className={isWide(logo.viewBox) ? "h-auto w-8" : "size-5.5"} fill={logo.color}>
          <path d={logo.path} />
        </svg>
      </span>
    )
  }
  if (logo?.kind === "mastercard") {
    return (
      <span aria-hidden="true" className={cn(CHIP_CLASS, "border-border bg-surface-hover")}>
        <MastercardCircles />
      </span>
    )
  }
  return (
    <span aria-hidden="true" className={cn(CHIP_CLASS, "border-border bg-surface-hover")}>
      <CreditCard className="size-4 text-muted-foreground" />
    </span>
  )
}

/** A wordmark (Visa, Discover) at full chip width; a square mark (Amex) at chip height. */
function isWide(viewBox: string): boolean {
  const [, , width = 1, height = 1] = viewBox.split(" ").map(Number)
  return width / height > 1.6
}

/** Two circles of radius 8, 8 apart, and the lens where they overlap. */
function MastercardCircles() {
  return (
    <svg viewBox="0 0 32 20" className="h-4.5 w-7">
      <circle cx="12" cy="10" r="8" fill="#EB001B" />
      <circle cx="20" cy="10" r="8" fill="#F79E1B" />
      <path d="M16 3.072a8 8 0 0 1 0 13.856a8 8 0 0 1 0-13.856z" fill="#FF5F00" />
    </svg>
  )
}
