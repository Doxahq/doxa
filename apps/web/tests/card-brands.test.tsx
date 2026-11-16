// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { CardBrandMark } from "~/components/dashboard/billing/card-brand-mark"
import { CARD_BRANDS, cardBrandOf } from "~/lib/dashboard/card-brands"

afterEach(cleanup)

describe("card brands", () => {
  test("names each Stripe brand and gives it a logo", () => {
    expect(cardBrandOf("visa")).toMatchObject({ name: "Visa", logo: { kind: "glyph", color: "#1A1F71" } })
    expect(cardBrandOf("MasterCard")).toEqual({ name: "Mastercard", logo: { kind: "mastercard" } })
    expect(cardBrandOf("amex").name).toBe("American Express")
    // UnionPay has no logo in the icon set: the generic card icon.
    expect(cardBrandOf("unionpay")).toEqual({ name: "UnionPay", logo: null })
    expect(cardBrandOf("eftpos_au")).toEqual({ name: "Eftpos_au", logo: null })
  })

  test.each(Object.entries(CARD_BRANDS))("%s draws a valid glyph", (_key, brand) => {
    if (brand.logo?.kind !== "glyph") return
    expect(brand.logo.path).toMatch(/^M[\d.\-\sA-Za-z,]+$/)
    expect(brand.logo.viewBox.split(" ").map(Number).every(Number.isFinite)).toBe(true)
  })

  test("the chip draws the brand logo, Mastercard's two circles, or the card icon", () => {
    const visa = render(<CardBrandMark logo={cardBrandOf("visa").logo} />)
    expect(visa.container.querySelector("svg")?.getAttribute("fill")).toBe("#1A1F71")
    expect(visa.container.querySelector("svg")?.getAttribute("class")).toBe("h-auto w-8")
    cleanup()
    const mastercard = render(<CardBrandMark logo={cardBrandOf("mastercard").logo} />)
    expect(mastercard.container.querySelectorAll("circle")).toHaveLength(2)
    cleanup()
    const generic = render(<CardBrandMark logo={null} />)
    expect(generic.container.querySelector(".lucide-credit-card")).toBeTruthy()
    // Decorative: the card name is in the text beside it.
    expect(generic.container.firstElementChild?.getAttribute("aria-hidden")).toBe("true")
  })
})
