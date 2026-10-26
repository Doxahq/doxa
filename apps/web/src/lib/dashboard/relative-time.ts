const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
]

/** "2 minutes ago", "3 days ago". */
export function formatRelativeAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000)
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit)
  }
  return RELATIVE.format(seconds, "second")
}
