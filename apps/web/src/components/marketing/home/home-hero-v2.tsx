import { Link } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { Hr } from "~/components/marketing/guides"
import { ConnectAgentButton } from "~/components/marketing/home/connect-agent-button"
import { SiteNav } from "~/components/marketing/site-nav"
import { ThemedPicture } from "~/components/ui/themed-picture"
import { HERO_V2_DOCS_SIZES, HERO_V2_IMAGES, HERO_V2_SCENE_SIZES, type HeroImage } from "~/lib/marketing/home-hero"
import { DOCS_URL, GET_STARTED_URL } from "~/lib/marketing/links"

/** The docs page in the screenshot. The address bar opens it in a new tab. */
const DOCS_DEMO_URL = `${DOCS_URL}/overview`
const DOCS_DEMO_LABEL = "docs.doxa.so/overview"

interface HeroPictureProps {
  image: HeroImage
  sizes: string
  className?: string
  alt?: string
  /** The first paint needs the scene, so the browser fetches it before other images. */
  priority?: boolean
}

function HeroPicture({ image, sizes, className, alt = "", priority = false }: HeroPictureProps) {
  return (
    <ThemedPicture
      files={image.files}
      className={className}
      sizes={sizes}
      alt={alt}
      width={image.width}
      height={image.height}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      aria-hidden={alt === "" ? true : undefined}
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
      <HeroPicture
        image={HERO_V2_IMAGES.docs}
        sizes={HERO_V2_DOCS_SIZES}
        alt="The Doxa docs site: the Doxa Platform Overview page, with its sidebar and table of contents."
        priority
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
        <h1 className="display hv2__title">Documentation that updates itself</h1>
        <p className="hv2__lede">
          Open-source platform that keeps your docs in sync with your codebase. An agent writes every page, rewrites it
          on each commit, and asks you before it publishes.
        </p>
        <div className="hv2__ctas">
          <a className="btn btn--light" href={GET_STARTED_URL}>
            Get started ›
          </a>
          <ConnectAgentButton />
        </div>
      </div>

      <div className="hv2__stage">
        <HeroPicture image={HERO_V2_IMAGES.back} sizes={HERO_V2_SCENE_SIZES} className="hv2__back" priority />
        <DocsWindow />
        <HeroPicture image={HERO_V2_IMAGES.front} sizes={HERO_V2_SCENE_SIZES} className="hv2__front" priority />
      </div>
      <div className="hv2__floor" aria-hidden="true" />
    </header>
  )
}
