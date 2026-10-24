import { useSiteConfig } from "@/src/site-config/site-config-context";

import { cn } from "@/src/lib/utils";
import { TableAnchor, TableAnchorProps } from "@/src/components/toc/anchor";
import { BackToTop } from "@/src/components/toc/backtotop";
import Feedback from "@/src/components/toc/feedback";

interface TableProps {
  tocs: TableAnchorProps;
  pathName: string;
  frontmatter: { title: string };
  className?: string;
}

export function TableOfContents({
  tocs,
  pathName,
  frontmatter,
  className,
}: TableProps) {
  const config = useSiteConfig();
  return (
    <>
      {config.features.rightSidebar && (
        <aside
          className={cn(
            "toc sticky top-[calc(var(--docs-navbar-h)+var(--docs-tabs-h)+1.5rem)] hidden max-h-[calc(100dvh-var(--docs-navbar-h)-var(--docs-tabs-h)-3rem)] max-w-[220px] min-w-[200px] gap-4 overflow-y-auto overscroll-contain pt-6 xl:flex xl:flex-col",
            className
          )}
          aria-label="Table of contents"
        >
          {config.features.tableOfContents && <TableAnchor tocs={tocs.tocs} />}
          {config.features.feedbackEdit && (
            <Feedback slug={pathName} title={frontmatter.title} />
          )}
          {config.features.scrollToTop && <BackToTop />}
        </aside>
      )}
    </>
  );
}
