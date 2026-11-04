import { useDemoMode } from "@/src/contexts/demo-mode";
import { getDocsRouteDataFromMatches } from "@/src/runtime/docs-route-data";
import { ConfigLink } from "@/src/site-config/config-link";
import { useSiteConfig } from "@/src/site-config/site-config-context";
import { docsLayout } from "@doxahq/site-config";
import { useRouterState } from "@tanstack/react-router";
import { LuArrowUpRight, LuGithub } from "react-icons/lu";

import { isChatAvailable } from "@/src/lib/chat-availability";
import { cn } from "@/src/lib/utils";
import { buttonVariants } from "@/src/components/ui/button";
import { SheetClose } from "@/src/components/ui/sheet";
import Anchor from "@/src/components/anchor";
import { ChatButton } from "@/src/components/chat/chat-button";
import { Logo } from "@/src/components/navigation/logo";
import SearchTrigger from "@/src/components/navigation/search-trigger";
import { SectionTabs } from "@/src/components/navigation/section-tabs";
import { SheetLeft } from "@/src/components/sidebar";
import { ModeToggle } from "@/src/components/theme-toggle";

export function Navbar() {
  const isDemoMode = useDemoMode();
  const config = useSiteConfig();
  const { navbar, features } = config;
  // The `in-navbar` placement: the section tabs fill the center, and a
  // smaller search box moves to the right, next to the other buttons. The
  // tabs need room, so below lg they stay in the bar under the top bar.
  const tabsInNavbar = docsLayout(config).sectionTabs === "in-navbar";
  return (
    <nav className="sticky top-0 z-50 mx-auto grid h-16 w-full grid-cols-[1fr_auto_1fr] items-center gap-3 border-b bg-background/80 px-4 backdrop-blur-xl sm:px-6 md:px-8">
      <div className="flex min-w-0 items-center gap-6">
        <SheetLeft />
        <div className="hidden md:flex">
          <Logo />
        </div>
        <div className="hidden items-center gap-5 text-sm font-medium text-muted-foreground md:flex">
          <NavMenu />
        </div>
      </div>

      <div
        className={cn("flex justify-center", tabsInNavbar && "self-stretch")}
      >
        {tabsInNavbar ? (
          <div className="hidden h-full lg:flex">
            <NavbarSectionTabs />
          </div>
        ) : (
          !isDemoMode && <SearchTrigger />
        )}
      </div>

      <div className="flex items-center justify-end gap-1">
        {tabsInNavbar && !isDemoMode && (
          <div className="mr-1">
            <SearchTrigger compact />
          </div>
        )}
        {navbar.cta && (
          <ConfigLink
            href={navbar.cta.href}
            newTab={navbar.cta.newTab}
            className={buttonVariants({
              variant: navbar.cta.variant === "outline" ? "outline" : "default",
            })}
          >
            {navbar.cta.label}
          </ConfigLink>
        )}
        {navbar.github && (
          <a
            href={navbar.github}
            className={buttonVariants({ variant: "ghost", size: "icon" })}
            rel="noopener noreferrer"
            title="View the repository on GitHub"
            aria-label="View the repository on GitHub"
          >
            <LuGithub className="h-[1.1rem] w-[1.1rem]" />
          </a>
        )}
        {isChatAvailable(features) && <ChatButton />}
        <ModeToggle />
      </div>
    </nav>
  );
}

/** The section tabs of the current docs page, for the `in-navbar` placement. */
function NavbarSectionTabs() {
  const routeData = useRouterState({
    select: (state) => getDocsRouteDataFromMatches(state.matches),
  });
  // Only on a docs page: elsewhere there is no current site's section list,
  // and the tabs would fall back to the bundled one.
  if (!routeData) return null;
  return (
    <SectionTabs
      variant="navbar"
      sections={routeData.sections}
      currentSectionSlug={routeData.currentSection?.slug ?? null}
      sectionHomeHrefs={routeData.sectionHomeHrefs}
    />
  );
}

export function NavMenu({ isSheet = false }) {
  const { navbar } = useSiteConfig();
  return (
    <>
      {navbar.links.map((item) => {
        const Comp = (
          <Anchor
            key={item.label + item.href}
            absolute
            activeClassName="font-semibold text-primary"
            className="flex items-center gap-1 text-sm hover:text-foreground"
            href={item.href}
            target={item.newTab ? "_blank" : undefined}
            rel={!item.href.startsWith("/") ? "noopener noreferrer" : undefined}
          >
            {item.label}{" "}
            {!item.href.startsWith("/") && (
              <LuArrowUpRight className="h-3 w-3 align-super" strokeWidth={3} />
            )}
          </Anchor>
        );
        return isSheet ? (
          <SheetClose key={item.label + item.href} asChild>
            {Comp}
          </SheetClose>
        ) : (
          Comp
        );
      })}
    </>
  );
}
