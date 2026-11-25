import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { Hr } from "~/components/marketing/guides"
import { ConnectAgentButton } from "~/components/marketing/home/connect-agent-button"
import { SiteNav } from "~/components/marketing/site-nav"
import { Picture } from "~/components/ui/picture"
import { ThemedPicture } from "~/components/ui/themed-picture"
import { ctaClickHandler } from "~/lib/analytics/capture-browser-event"
import { HERO_V2_DOCS_SIZES, HERO_V2_IMAGES, HERO_V2_SCENE_SIZES, type HeroImage } from "~/lib/marketing/home-hero"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"
import type { PictureFiles } from "~/lib/theme/picture-files"

/** The docs page in the screenshot. The address bar opens it in a new tab. */
const DOCS_DEMO_URL = `${DOCS_URL}/overview`
const DOCS_DEMO_LABEL = "docs.doxa.so/overview"

/**
 * One layer of the dune scene. It is the same in both themes, so it loads eagerly at high
 * priority: the browser finds it in the HTML and fetches it with the stylesheets. Until
 * it arrives, a small blurred copy in its CSS background draws the scene on the first
 * paint (home-hero-v2.css).
 */
function SceneLayer({ image, className }: { image: HeroImage<PictureFiles>; className: string }) {
  return (
    <Picture
      files={image.files}
      sizes={HERO_V2_SCENE_SIZES}
      className={className}
      alt=""
      width={image.width}
      height={image.height}
      loading="eager"
      decoding="async"
      fetchPriority="high"
      aria-hidden
    />
  )
}

function DocsWindow() {
  return (
    <figure className="hv2__shot">
      <div className="hv2__bar">
        <span className="hv2__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <a className="hv2__url" href={DOCS_DEMO_URL} target="_blank" rel="noreferrer" title="Open docs.doxa.so in a new tab">
          <Lock aria-hidden="true" size={11} strokeWidth={2.25} />
          <span className="hv2__url-text">{DOCS_DEMO_LABEL}</span>
        </a>
        <span className="hv2__bar-end" aria-hidden="true" />
      </div>
      {/* Lazy, so only the copy of the theme on show loads. Until it arrives, a blurred copy
          in its CSS background fills the window (home-hero-v2.css). */}
      <ThemedPicture
        files={HERO_V2_IMAGES.docs.files}
        sizes={HERO_V2_DOCS_SIZES}
        alt="The Doxa docs site: the Doxa Platform Overview page, with its sidebar and table of contents."
        width={HERO_V2_IMAGES.docs.width}
        height={HERO_V2_IMAGES.docs.height}
        decoding="async"
        fetchPriority="high"
      />
    </figure>
  )
}

/**
 * Hero v2: centered copy over a night sky (a daylight sky in the light theme), and a
 * window of the Doxa docs that rises out of the dunes. The window stands between two
 * layers of one photo: the big lit dune behind it, and the lower dune band, whose
 * glowing edge crosses the window.
 * The swap with the first hero is `HOME_HERO_VERSION` in `lib/marketing/home-hero.ts`.
 */
export function HomeHeroV2() {
  return (
    <header className="hv2">
      <SiteNav current="home" />
      <Hr />

      <div className="hv2__copy">
        <Link className="pill" to="/mcp">
          <b>NEW</b>DOXA MCP SERVER IS LIVE →
        </Link>
        <h1 className="display hv2__title">
          Your agents
          <br />
          write your docs
        </h1>
        <p className="hv2__lede">
          Open-source platform that keeps your docs in sync with your codebase. An agent writes every page, rewrites it
          on each commit, and asks you before it publishes.
        </p>
        <div className="hv2__ctas">
          <a className="btn btn--light" href={GET_STARTED_URL} onClick={ctaClickHandler("home_hero", "get_started")}>
            Get started ›
          </a>
          <ConnectAgentButton location="home_hero" />
        </div>
      </div>

      <div className="hv2__stage">
        <SceneLayer image={HERO_V2_IMAGES.back} className="hv2__back" />
        <DocsWindow />
        <SceneLayer image={HERO_V2_IMAGES.front} className="hv2__front" />
      </div>
      <div className="hv2__floor" aria-hidden="true" />
    </header>
  )
}
