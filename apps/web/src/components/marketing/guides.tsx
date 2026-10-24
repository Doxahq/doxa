import type { CSSProperties } from "react"

/** A dashed full-width guide line with a "+" where it meets each column rail. */
export function Hr({ label }: { label?: string }) {
  return (
    <div className="hr">
      {label ? <span className="hr__n">{label}</span> : null}
    </div>
  )
}

type Tick = { top: number; left?: string; right?: string }

/** Short dashed ticks in the side gutters of a hero. */
export function Ticks({ side, ticks }: { side: "l" | "r"; ticks: Tick[] }) {
  return (
    <div className={`ticks ticks--${side}`} aria-hidden="true">
      {ticks.map((t) => {
        const style: CSSProperties = { top: `${t.top}px` }
        if (t.left) style.left = t.left
        if (t.right) style.right = t.right
        return <i key={t.top} style={style} />
      })}
    </div>
  )
}
