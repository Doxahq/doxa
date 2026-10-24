import { useSiteConfig } from "@/src/site-config/site-config-context";
import { useLocation } from "@tanstack/react-router";

import type { IconName } from "@/src/settings/icons";
import { createDocsSidebarLinkPreload } from "@/src/lib/preload-policy";
import { cn } from "@/src/lib/utils";
import { SheetClose } from "@/src/components/ui/sheet";
import Anchor from "@/src/components/anchor";
import {
  isHttpMethodBadge,
  SidebarNavMarker,
  sidebarNavTitle,
} from "@/src/components/sidebar/http-method-badge";

export interface SubLinkRoute {
  title: string;
  href: string;
  icon?: IconName;
  badge?: string;
  noLink?: true;
}

export default function SubLink(props: SubLinkRoute & { isSheet: boolean }) {
  const docsSidebarLinkPreload = createDocsSidebarLinkPreload(
    useSiteConfig().features
  );
  const location = useLocation();
  const path = location.pathname;

  const { title, href, icon, badge, noLink, isSheet } = props;
  const isActive = path === href;
  const displayTitle = sidebarNavTitle(title, badge);

  const Comp = (
    <Anchor
      activeClassName="text-primary font-medium"
      href={href}
      title={displayTitle}
      {...docsSidebarLinkPreload}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/80 hover:bg-muted hover:text-foreground",
        isActive &&
          "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary"
      )}
    >
      <SidebarNavMarker icon={icon} badge={badge} />
      <span className="min-w-0 truncate">{displayTitle}</span>
      {badge && !isHttpMethodBadge(badge) && (
        <span className="ml-auto shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] leading-none text-muted-foreground">
          {badge}
        </span>
      )}
    </Anchor>
  );

  const titleOrLink = !noLink ? (
    isSheet ? (
      <SheetClose asChild>{Comp}</SheetClose>
    ) : (
      Comp
    )
  ) : (
    <h2 className="flex items-center gap-2 px-2 py-1.5 text-sm font-semibold text-foreground">
      <SidebarNavMarker icon={icon} badge={badge} />
      <span>{displayTitle}</span>
    </h2>
  );

  return <div className="flex flex-col">{titleOrLink}</div>;
}
