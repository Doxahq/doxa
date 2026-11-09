const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

const EXACT = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" })

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

/** "November 3, 2026 at 2:05:09 PM GMT+1", in the time zone of the browser. */
export function formatExactDate(iso: string): string {
  return EXACT.format(new Date(iso))
}
