import type { ComponentProps } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "../lib/cn";

/**
 * The tab set of a documentation page. The editor and the published site
 * render these, so a tab set looks the same in both.
 */
export function Tabs({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <div className="-mx-1 max-w-full overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn(
          "inline-flex h-9 w-max min-w-full items-center justify-start rounded-lg bg-muted p-[3px] text-muted-foreground sm:w-fit sm:justify-center",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-4 py-2 text-xs font-medium whitespace-nowrap text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:shadow-sm dark:text-muted-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}
