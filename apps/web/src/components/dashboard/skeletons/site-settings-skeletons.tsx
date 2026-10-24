import { useRouterState } from "@tanstack/react-router"

import {
  Bar,
  PageBodySkeleton,
  PageHeadingSkeleton,
  SkeletonRegion,
  TextBar,
} from "~/components/dashboard/skeletons/skeleton-kit"

type Section = "appearance" | "navigation" | "domains" | "seo" | "features" | "advanced"

interface CardShape {
  title: string
  /** The number of field rows in the card. */
  rows: number
}

/** Each section's heading and the shape of its first cards, with their real titles. */
const SECTIONS: Record<Section, { title: string; description: string; cards: CardShape[] }> = {
  appearance: {
    title: "Appearance",
    description: "The site name, logos, theme and layout that readers see.",
    cards: [{ title: "Site", rows: 3 }, { title: "Logo", rows: 2 }, { title: "Layout", rows: 2 }],
  },
  navigation: {
    title: "Navigation",
    description: "The default page, and the links in the site header and footer.",
    cards: [{ title: "Default page", rows: 1 }, { title: "Call to action", rows: 2 }, { title: "Links", rows: 2 }],
  },
  domains: {
    title: "Domains",
    description: "Connect a hostname and confirm DNS, TLS, and documentation delivery in one place.",
    cards: [],
  },
  seo: {
    title: "SEO & sharing",
    description: "How search engines and social previews describe the site.",
    cards: [{ title: "Search", rows: 2 }, { title: "Social sharing", rows: 2 }],
  },
  features: {
    title: "Features",
    description: "Turn site features on or off.",
    cards: [{ title: "Page layout", rows: 4 }, { title: "AI assistant", rows: 2 }],
  },
  advanced: {
    title: "Advanced (JSON)",
    description:
      "Edit every site setting as JSON. It edits the same settings as the other sections, and shows the same issues.",
    cards: [],
  },
}

function sectionOf(pathname: string): Section {
  const name = /\/site\/([^/]+)/.exec(pathname)?.[1]
  return name && name in SECTIONS ? (name as Section) : "appearance"
}

/** The section the router is going to, read from the location that is loading. */
function useLoadingSection(): Section {
  return sectionOf(useRouterState({ select: (state) => state.location.pathname }))
}

/**
 * The Site settings route while its code or the site config loads: the
 * section's page in the settings column.
 */
export function SiteSettingsPending() {
  const section = useLoadingSection()
  return (
    <PageBodySkeleton label="Loading site settings" className="max-w-4xl">
      <SiteSettingsSectionContent section={section} />
    </PageBodySkeleton>
  )
}

/** A section route while its code loads, inside the settings column that stays. */
export function SiteSettingsSectionPending() {
  const section = useLoadingSection()
  return (
    <SkeletonRegion label="Loading settings" className="flex flex-col gap-8">
      <SiteSettingsSectionContent section={section} />
    </SkeletonRegion>
  )
}

function SiteSettingsSectionContent({ section }: { section: Section }) {
  const shape = SECTIONS[section]
  return (
    <>
      <PageHeadingSkeleton label="Site settings" title={shape.title} description={shape.description} />
      {section === "domains" ? <DomainsSkeleton /> : null}
      {section === "advanced" ? (
        <div className="surface-card min-h-[32rem] p-4">
          <div className="flex flex-col gap-3">
            {["6%", "28%", "40%", "34%", "22%", "46%", "30%", "8%"].map((width, index) => (
              <Bar key={index} width={width} height="0.625rem" style={{ marginLeft: index === 0 || index === 7 ? 0 : "1.25rem" }} />
            ))}
          </div>
        </div>
      ) : null}
      {shape.cards.map((card) => (
        <SettingsCardSkeleton key={card.title} card={card} />
      ))}
    </>
  )
}

/** `SettingsSection` with its real title, and a label and a control bar per field. */
function SettingsCardSkeleton({ card }: { card: CardShape }) {
  return (
    <section className="surface-card">
      <header className="flex items-start justify-between gap-4 border-b border-divider px-5 py-4">
        <div className="space-y-1">
          <h3 className="font-mono text-xs font-bold tracking-[0.14em] text-foreground uppercase">{card.title}</h3>
          <TextBar width="18rem" className="text-[13px] leading-5" />
        </div>
      </header>
      <div className="space-y-5 px-5 py-5">
        {Array.from({ length: card.rows }, (_, index) => (
          <div key={index} className="@container">
            <div className="grid items-start gap-1.5 @[560px]:grid-cols-[200px_minmax(0,1fr)] @[560px]:gap-x-6">
              <div className="flex min-h-5 items-center @[560px]:min-h-9">
                <Bar width={["5.5rem", "4.5rem", "6.5rem", "5rem"][index % 4]} height="0.75rem" />
              </div>
              <Bar width="100%" height="2.25rem" className="rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/** The Domains card: the add form, then two domain rows. */
export function DomainsSkeleton() {
  return (
    <div className="surface-card flex flex-col gap-4 p-4">
      <div className="flex gap-2">
        <Bar width="100%" height="2.25rem" className="rounded-md" />
        <Bar width="7rem" height="2.25rem" className="rounded-md" />
      </div>
      <DomainRowsSkeleton />
    </div>
  )
}

/** Two domain cards, for the Domains list while it loads. */
export function DomainRowsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {["12rem", "9rem"].map((width) => (
        <div key={width} className="surface-card flex items-center justify-between gap-4 px-4 py-4">
          <div className="flex min-w-0 flex-col gap-2">
            <Bar width={width} height="0.85rem" />
            <Bar width="6rem" height="0.65rem" />
          </div>
          <Bar width="4.5rem" height="1.25rem" className="rounded-md" />
        </div>
      ))}
    </div>
  )
}
