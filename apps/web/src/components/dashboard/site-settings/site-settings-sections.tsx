import { lazy, Suspense } from "react"
import { Loader2 } from "lucide-react"

import { BrandingTab } from "~/components/dashboard/content/site-settings/tabs/branding-tab"
import { FeaturesTab } from "~/components/dashboard/content/site-settings/tabs/features-tab"
import { FooterTab } from "~/components/dashboard/content/site-settings/tabs/footer-tab"
import { HomePageTab } from "~/components/dashboard/content/site-settings/tabs/home-page-tab"
import { LayoutTab } from "~/components/dashboard/content/site-settings/tabs/layout-tab"
import { NavbarTab } from "~/components/dashboard/content/site-settings/tabs/navbar-tab"
import { SeoTab } from "~/components/dashboard/content/site-settings/tabs/seo-tab"
import { ThemeTab } from "~/components/dashboard/content/site-settings/tabs/theme-tab"
import { PageHeading } from "~/components/dashboard/dashboard-header"
import { ProjectDomainsPage } from "~/components/dashboard/project-domains-page"
import { useSiteSettingsReveal } from "~/components/dashboard/site-settings/site-settings-layout"

// The JSON editor carries CodeMirror and the JSON language. It loads only
// when a person opens the Advanced section.
const JsonTab = lazy(() => import("~/components/dashboard/content/site-settings/tabs/json-tab"))

export function AppearanceSettingsPage() {
  return (
    <>
      <PageHeading
        label="Site settings"
        title="Appearance"
        description="The site name, logos, theme and layout that readers see."
      />
      <BrandingTab afterSite={<LayoutTab />} />
      <ThemeTab />
    </>
  )
}

export function NavigationSettingsPage() {
  return (
    <>
      <PageHeading
        label="Site settings"
        title="Navigation"
        description="The default page, and the links in the site header and footer."
      />
      <HomePageTab />
      <NavbarTab />
      <FooterTab />
    </>
  )
}

export function DomainsSettingsPage({ projectId }: { projectId: string }) {
  return (
    <>
      <PageHeading
        label="Site settings"
        title="Domains"
        description="Connect a hostname and confirm DNS, TLS, and documentation delivery in one place."
      />
      <ProjectDomainsPage projectId={projectId} />
    </>
  )
}

export function SeoSettingsPage() {
  return (
    <>
      <PageHeading
        label="Site settings"
        title="SEO & sharing"
        description="How search engines and social previews describe the site."
      />
      <SeoTab />
    </>
  )
}

export function FeaturesSettingsPage() {
  return (
    <>
      <PageHeading
        label="Site settings"
        title="Features"
        description="Turn site features on or off."
      />
      <FeaturesTab />
    </>
  )
}

export function AdvancedSettingsPage() {
  const reveal = useSiteSettingsReveal()
  return (
    <>
      <PageHeading
        label="Site settings"
        title="Advanced (JSON)"
        description="Edit every site setting as JSON. It edits the same settings as the other sections, and shows the same issues."
      />
      <Suspense
        fallback={
          <div className="flex h-72 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase">Loading editor</span>
          </div>
        }
      >
        {/* The editor fills the rest of the page. On a short screen it keeps a
            usable height, and the page scrolls. */}
        <div className="flex min-h-[32rem] flex-1 flex-col">
          <JsonTab reveal={reveal} />
        </div>
      </Suspense>
    </>
  )
}
