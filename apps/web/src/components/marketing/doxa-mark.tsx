import { LogoGlyph } from "~/components/navigation/logo"

/** The Doxa logo at the size of the marketing nav and footer. */
export function DoxaMark({ width = 15, height = 18 }: { width?: number; height?: number }) {
  return <LogoGlyph width={width} height={height} />
}
