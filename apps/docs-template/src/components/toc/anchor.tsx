import { LuList } from "react-icons/lu";

import { TOC_ACTIVE_ATTRIBUTE, TOC_LINK_ATTRIBUTE } from "@/src/lib/hash-scroll-script";
import { hrefToId } from "@/src/lib/toc";
import { cn } from "@/src/lib/utils";
import { useScrollSpy, type TocItem } from "@/src/hooks/use-scroll-spy";
import { ScrollArea } from "@/src/components/ui/scroll-area";

export interface TableAnchorProps {
  tocs: TocItem[];
}

const levelPadding: Record<number, string> = {
  2: "pl-3",
  3: "pl-6",
  4: "pl-9",
};

export function TableAnchor({ tocs }: TableAnchorProps) {
  const { activeId, handleSmoothScroll } = useScrollSpy(tocs);

  if (!tocs.length) return null;

  return (
    <div className="flex w-full flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <LuList className="h-4 w-4" />
        On this page
      </h3>
      <ScrollArea className="pb-4">
        {/* The 1px list line runs under the centre of the 16px icon. */}
        <div className="ml-[7.5px] flex flex-col border-l border-border/50">
          {tocs.map(({ href, level, text }) => (
            <a
              key={href}
              href={href}
              title={text}
              aria-label={text}
              onClick={(e) => handleSmoothScroll(e, href)}
              {...{
                [TOC_LINK_ATTRIBUTE]: "",
                // An attribute, not a class, so the inline script in
                // __root.tsx can mark the current item before the app loads.
                [TOC_ACTIVE_ATTRIBUTE]: String(activeId === hrefToId(href)),
              }}
              className={cn(
                "relative py-1.5 text-sm text-muted-foreground hover:text-foreground",
                "data-[active=true]:text-primary data-[active=true]:hover:text-primary",
                // The current item's marker: a short 1px bar over the list's
                // line, beside the first line of text. It takes no width, and
                // the weight does not change, so no item wraps when marked.
                "before:absolute before:top-2 before:-left-px before:h-4 before:w-px before:bg-primary before:opacity-0 data-[active=true]:before:opacity-100",
                levelPadding[level]
              )}
            >
              {text}
            </a>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
