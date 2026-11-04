import type { CSSProperties } from "react"

type Track = { key: string; value: string; className?: string; stale?: boolean }

const TRACKS: Track[] = [
  { key: "code", value: "ships daily" },
  { key: "docs", value: "out of date", className: "ab-track--stale", stale: true },
  { key: "doxa", value: "in sync", className: "ab-track--doxa" },
]

export function AboutWhy() {
  return (
    <section className="col" aria-label="Why we built Doxa">
      <div className="ab-why">
        <div className="ab-why__copy">
          <span className="label">Why we built it</span>
          <h2 className="display">
            Docs drift.
            <br />
            We fix that.
          </h2>
          <p>
            Code changes every day. Docs change when someone finds the time. The gap grows until
            readers stop trusting the docs.
          </p>
          <p>We started Doxa to close that gap for good: the docs move when the code moves.</p>
        </div>
        <div className="ab-drift vdiv" aria-hidden="true">
          <div className="ab-drift__bar">
            <i />
            <i />
            <i />
            <b>git log --graph</b>
            <span>illustration</span>
          </div>
          {TRACKS.map((track) => (
            <div key={track.key} className={track.className ? `ab-track ${track.className}` : "ab-track"}>
              <span className="ab-track__k">{track.key}</span>
              <span className="ab-track__line">
                {/* The stale docs line has one commit, then seven missed ones. */}
                {Array.from({ length: 8 }, (_, i) => (
                  <i
                    key={i}
                    className={track.stale && i > 0 ? "x" : undefined}
                    style={{ "--i": i + 1 } as CSSProperties}
                  />
                ))}
              </span>
              <span className="ab-track__v">{track.value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
