import type { ReactNode } from "react"

const DOWNLOAD_PATH = "M9 2.5v9M5.5 8 9 11.5 12.5 8M3 13.5v2h12v-2"

const POINTS: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: "Self-host anywhere",
    text: "Run the full platform on your own servers, if you want to.",
    icon: (
      <>
        <rect x="2.5" y="3" width="13" height="5" />
        <rect x="2.5" y="10" width="13" height="5" />
        <path d="M5 5.5h.1M5 12.5h.1" />
      </>
    ),
  },
  {
    title: "No vendor lock-in",
    text: "Your pages are plain MDX, not a closed format. Leave any time.",
    icon: (
      <>
        <rect x="3.5" y="8" width="11" height="8" />
        <path d="M6 8V5.5a3 3 0 0 1 5.8-1.1" />
      </>
    ),
  },
  {
    title: "One-click export",
    text: "Download every page, image and setting in one archive.",
    icon: <path d={DOWNLOAD_PATH} />,
  },
]

export function AboutOpen() {
  return (
    <section className="col" id="open" aria-label="Open by design">
      <div className="op">
        <div className="op__copy">
          <span className="label">Open by design</span>
          <h2 className="display">
            Your docs.
            <br />
            <span className="mark">Your servers.</span>
          </h2>
          <p>
            Doxa is open source. Use our cloud, or self-host the whole platform on your own
            infrastructure. Either way, your docs stay yours.
          </p>
          <ul className="op__list">
            {POINTS.map((point) => (
              <li key={point.title}>
                <span className="op__i">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    aria-hidden="true"
                  >
                    {point.icon}
                  </svg>
                </span>
                <div>
                  <b>{point.title}</b>
                  <span>{point.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="op__art vdiv" aria-hidden="true">
          <div className="op__win">
            <div className="op__bar">
              <i />
              <i />
              <i />
              <b>doxa · export</b>
              <span className="op__btn">
                <svg width="12" height="12" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d={DOWNLOAD_PATH} />
                </svg>
                Export docs
              </span>
            </div>
            <pre>
              <div>
                <span className="t-k">api-docs-export.zip</span>
              </div>
              <div>
                <span className="t-p">{"├─ "}</span>pages/
              </div>
              <div>
                <span className="t-p">{"│  ├─ "}</span>index.mdx
              </div>
              <div>
                <span className="t-p">{"│  ├─ "}</span>quickstart.mdx
              </div>
              <div>
                <span className="t-p">{"│  └─ "}</span>guides/auth.mdx
              </div>
              <div>
                <span className="t-p">{"├─ "}</span>assets/
              </div>
              <div>
                <span className="t-p">{"└─ "}</span>
                <span className="t-s">doxa.json</span>
                <span className="t-c">{"  site config"}</span>
              </div>
            </pre>
          </div>
          <div className="op__win">
            <div className="op__bar">
              <i />
              <i />
              <i />
              <b>self-host</b>
              <span className="op__ok">your infrastructure</span>
            </div>
            <pre>
              <div>
                <span className="t-p">{"$ "}</span>git clone [REPO URL]
              </div>
              <div>
                <span className="t-p">{"$ "}</span>[SELF-HOST COMMAND]
              </div>
              <div>
                <span className="t-c">{"  ✓ Doxa is running on your servers"}</span>
              </div>
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}
