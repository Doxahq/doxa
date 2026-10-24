/**
 * WCAG contrast for the CSS color forms that the site config accepts.
 *
 * The config schema already validated every value, so this module only
 * parses the accepted grammars: hex, rgb(), hsl(), oklch(), and oklab(). Alpha
 * is ignored: a token is treated as opaque on its paired surface.
 */

type LinearRgb = readonly [number, number, number]

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`
const CHANNEL = String.raw`(${NUMBER})(%)?`
const ALPHA = String.raw`(?:\s*/\s*${NUMBER}%?)?`
const FUNCTION_PATTERN = new RegExp(
  String.raw`^(rgba?|hsla?|oklch|oklab)\(\s*${CHANNEL}(?:deg)?[\s,]+${CHANNEL}(?:deg)?[\s,]+${CHANNEL}(?:deg)?(?:[\s,]+${NUMBER}%?)?${ALPHA}\s*\)$`,
  "i",
)

export function contrastRatio(first: string, second: string): number | null {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  if (a === null || b === null) return null
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

export function relativeLuminance(color: string): number | null {
  const rgb = parseLinearRgb(color.trim())
  if (!rgb) return null
  const [r, g, b] = rgb.map(clampUnit)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function parseLinearRgb(color: string): LinearRgb | null {
  if (color.startsWith("#")) return parseHex(color)
  const match = FUNCTION_PATTERN.exec(color)
  if (!match) return null
  const name = match[1].toLowerCase()
  const channels = [
    { value: Number(match[2]), percent: match[3] === "%" },
    { value: Number(match[4]), percent: match[5] === "%" },
    { value: Number(match[6]), percent: match[7] === "%" },
  ] as const
  if (name.startsWith("rgb")) {
    const [r, g, b] = channels.map(({ value, percent }) =>
      srgbToLinear((percent ? value / 100 : value / 255)),
    )
    return [r, g, b]
  }
  if (name.startsWith("hsl")) {
    return hslToLinear(channels[0].value, channels[1].value / 100, channels[2].value / 100)
  }
  const lightness = channels[0].percent ? channels[0].value / 100 : channels[0].value
  // CSS Color 4: 100% of chroma, a, or b equals 0.4.
  const scale = (channel: { value: number; percent: boolean }) =>
    channel.percent ? (channel.value / 100) * 0.4 : channel.value
  if (name === "oklch") {
    const chroma = scale(channels[1])
    const hue = (channels[2].value * Math.PI) / 180
    return oklabToLinear(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue))
  }
  return oklabToLinear(lightness, scale(channels[1]), scale(channels[2]))
}

function parseHex(color: string): LinearRgb | null {
  const hex = color.slice(1)
  if (!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null
  const full =
    hex.length <= 4
      ? [...hex.slice(0, 3)].map((digit) => digit + digit).join("")
      : hex.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((start) =>
    srgbToLinear(Number.parseInt(full.slice(start, start + 2), 16) / 255),
  )
  return [r, g, b]
}

function hslToLinear(hue: number, saturation: number, lightness: number): LinearRgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const sector = (((hue % 360) + 360) % 360) / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r1, g1, b1] =
    sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
    : sector < 3 ? [0, chroma, second]
    : sector < 4 ? [0, second, chroma]
    : sector < 5 ? [second, 0, chroma]
    : [chroma, 0, second]
  const offset = lightness - chroma / 2
  return [srgbToLinear(r1 + offset), srgbToLinear(g1 + offset), srgbToLinear(b1 + offset)]
}

/** OKLab to linear sRGB, with the matrices from the OKLab specification. */
function oklabToLinear(lightness: number, a: number, b: number): LinearRgb {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

function srgbToLinear(channel: number): number {
  const value = clampUnit(channel)
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}
