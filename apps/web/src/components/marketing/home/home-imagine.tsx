import { EMBERS } from "~/lib/marketing/home"
import { GITHUB_URL } from "~/lib/marketing/links"

/** The closing scene: a framed night sky with a rocket lifting off out of it. */
export function HomeImagine() {
  return (
    <section className="imagine" aria-label="Imagine">
      <div className="imagine__dots" aria-hidden="true" />
      <h2 className="imagine__title">
        Imagine a codebase where
        <br />
        <em>the docs write themselves</em>
      </h2>
      <div className="imagine__stage">
        <figure className="frame">
          <div className="frame__bar">
            <i />
            DOXA, DOCUMENTATION THAT UPDATES ITSELF
            <span className="frame__stripes" />
            <b>⊡</b>
          </div>
          <div className="frame__art">
            <img src="/marketing/launch-sky.png" alt="A dithered night sky with a large glowing cloud" />
          </div>
        </figure>
        <div className="launch">
          <img
            src="/marketing/launch-rocket.webp"
            alt="A white Saturn V rocket lifts off through the clouds and out of the top of the frame. Its launch cloud breaks into pixels."
          />
          <span className="engine" aria-hidden="true" />
          {EMBERS.map((ember) => (
            <span
              key={`${ember.left}-${ember.top}`}
              className={ember.tone ? `ember ember--${ember.tone}` : "ember"}
              style={{ left: ember.left, top: ember.top, animationDelay: ember.delay }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <div className="imagine__foot">
        <h3>Documentation, kept true by your code</h3>
        <p>
          Doxa is an open-source platform that reads your repository, writes the docs and rewrites them on every merge.
          You review, it publishes.
        </p>
        <div className="row">
          <a className="btn btn--light" href="#">
            See how it works ›
          </a>
          <a className="btn btn--line" href={GITHUB_URL}>
            Star on GitHub ›
          </a>
        </div>
      </div>
    </section>
  )
}
