import { useCallback, useSyncExternalStore } from "react";

/**
 * A sidebar menu is a flat list: spacers, group headings, and pages. A group
 * is a heading and the pages that follow it, up to the next heading or
 * spacer. Pages before the first heading belong to no group.
 */
export type MenuBlock<TPage, TItem> =
  | { type: "item"; item: TItem; index: number }
  | { type: "group"; heading: string; pages: TPage[]; index: number };

export function groupMenu<TItem, TPage extends TItem>(
  items: readonly TItem[],
  isHeading: (item: TItem) => item is TItem & { heading: string },
  isPage: (item: TItem) => item is TPage
): MenuBlock<TPage, TItem>[] {
  const blocks: MenuBlock<TPage, TItem>[] = [];
  let group: Extract<MenuBlock<TPage, TItem>, { type: "group" }> | null = null;
  items.forEach((item, index) => {
    if (isHeading(item)) {
      group = { type: "group", heading: item.heading, pages: [], index };
      blocks.push(group);
    } else if (isPage(item) && group) {
      group.pages.push(item);
    } else {
      group = null;
      blocks.push({ type: "item", item, index });
    }
  });
  return blocks;
}

// Collapsed groups, for the whole visit. They survive moves between pages,
// which remount the sidebar, and reset on a reload, where every group starts
// expanded again, as the server renders it.
const collapsed = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a group is collapsed, and a setter. `key` names the group. */
export function useCollapsedGroup(
  key: string
): [boolean, (isCollapsed: boolean) => void] {
  const isCollapsed = useSyncExternalStore(
    subscribe,
    () => collapsed.has(key),
    () => false
  );
  const setCollapsed = useCallback(
    (next: boolean) => {
      if (next === collapsed.has(key)) return;
      if (next) collapsed.add(key);
      else collapsed.delete(key);
      listeners.forEach((listener) => listener());
    },
    [key]
  );
  return [isCollapsed, setCollapsed];
}
