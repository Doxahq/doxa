import { cn } from "~/lib/utils"

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const
/** One row of the digit column. Every character uses it, so the digits and the separators line up. */
const ROW_CLASS = "block h-[1.25em] leading-[1.25em]"

/**
 * A number whose digits roll to their new value, like an odometer. Each
 * digit is a column of 0 to 9 that slides. The digits key from the right,
 * so a place keeps its column when the number gets longer (999 to 1,000).
 * Screen readers read the plain text.
 */
export function RollingNumber({ text, className }: { text: string; className?: string }) {
  const chars = [...text]
  return (
    <span className={cn("inline-flex tabular-nums", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="inline-flex">
        {chars.map((char, index) => {
          const place = chars.length - index
          return isDigit(char) ? (
            <RollingDigit key={`digit-${place}`} digit={Number(char)} />
          ) : (
            <span key={`char-${place}`} className={ROW_CLASS}>
              {char}
            </span>
          )
        })}
      </span>
    </span>
  )
}

function RollingDigit({ digit }: { digit: number }) {
  return (
    <span className="inline-block h-[1.25em] overflow-hidden">
      <span
        className="flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ transform: `translateY(${-digit * 1.25}em)` }}
      >
        {DIGITS.map((value) => (
          <span key={value} className={ROW_CLASS}>
            {value}
          </span>
        ))}
      </span>
    </span>
  )
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9"
}
