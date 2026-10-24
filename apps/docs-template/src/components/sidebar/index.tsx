import { useDemoMode } from "@/src/contexts/demo-mode";
import type { RuntimeNavNode, RuntimeSection } from "@/src/runtime";
import { getDocsRouteDataFromMatches } from "@/src/runtime/docs-route-data";
import { useLocation, useRouterState } from "@tanstack/react-router";
import { LuAlignLeft } from "react-icons/lu";

import { getSectionFromPath } from "@/src/settings/sections";
import { getRoutesForSection } from "@/src/lib/pageroutes";
import { Button } from "@/src/components/ui/button";
import { DialogTitle } from "@/src/components/ui/dialog";
import { ScrollArea } from "@/src/components/ui/scroll-area";
import { Separator } from "@/src/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "@/src/components/ui/sheet";
import { Logo } from "@/src/components/navigation/logo";
import { NavMenu } from "@/src/components/navigation/navbar";
import { PageMenu } from "@/src/components/sidebar/pagemenu";

interface RuntimeSidebarProps {
  section?: RuntimeSection | null;
  routes?: RuntimeNavNode[];
}

export function Sidebar({ section, routes }: RuntimeSidebarProps = {}) {
  const isDemoMode = useDemoMode();
  const location = useLocation();
  const runtimeSidebarData = useRuntimeSidebarData();
  const fallbackSection = getSectionFromPath(location.pathname);
  const sidebarSection =
    section ?? runtimeSidebarData?.currentSection ?? fallbackSection;
  const sidebarRoutes =
    routes ??
    runtimeSidebarData?.sectionNavigation ??
    getRoutesForSection(fallbackSection.slug);
  const variant = sidebarSection?.layout === "reference" ? "reference" : "docs";

  // The sidebar takes the width of its longest item, from 240px up to a
  // limit that grows with the screen. Longer titles end in an ellipsis.
  return (
    <aside
      className={`sticky top-[calc(var(--docs-navbar-h)+var(--docs-tabs-h))] hidden h-[calc(100dvh-var(--docs-navbar-h)-var(--docs-tabs-h))] w-max max-w-[240px] min-w-[240px] shrink-0 flex-col lg:max-w-[288px] xl:max-w-[336px] overscroll-contain md:flex ${isDemoMode ? "overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "overflow-y-auto"}`}
      aria-label="Page navigation"
    >
      {/* Radix wraps the content in a `display: table` box that grows with
          it. A block keeps the items inside the sidebar width, so a long
          title ends in an ellipsis instead of running past the edge. */}
      <ScrollArea className="pt-6 pr-3 pb-8 [&_[data-radix-scroll-area-viewport]>div]:block!">
        <PageMenu routes={sidebarRoutes} variant={variant} />
      </ScrollArea>
    </aside>
  );
}

export function SheetLeft({ section, routes }: RuntimeSidebarProps = {}) {
  const location = useLocation();
  const runtimeSidebarData = useRuntimeSidebarData();
  const fallbackSection = getSectionFromPath(location.pathname);
  const sidebarSection =
    section ?? runtimeSidebarData?.currentSection ?? fallbackSection;
  const sidebarRoutes =
    routes ??
    runtimeSidebarData?.sectionNavigation ??
    getRoutesForSection(fallbackSection.slug);
  const variant = sidebarSection?.layout === "reference" ? "reference" : "docs";

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="flex cursor-pointer md:hidden"
        >
          <LuAlignLeft className="size-6!" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex h-full flex-col gap-0 px-0" side="left">
        <DialogTitle className="sr-only">Menu</DialogTitle>
        <SheetHeader>
          <SheetClose asChild>
            <Logo />
          </SheetClose>
        </SheetHeader>
        <ScrollArea className="flex h-full flex-col overflow-y-auto">
          <div className="mx-0 mt-3 flex flex-col gap-2.5 px-5">
            <NavMenu isSheet />
            <Separator className="my-2" />
            <PageMenu isSheet routes={sidebarRoutes} variant={variant} />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function useRuntimeSidebarData() {
  return useRouterState({
    select: (state) => getDocsRouteDataFromMatches(state.matches),
  });
}
