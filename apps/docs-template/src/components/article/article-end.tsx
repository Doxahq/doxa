import type { ComponentProps } from "react";

import { Pagination } from "@/src/components/article/pagination";

/**
 * The end of the article, above the footer: the cards to the previous and the
 * next page. The "Powered by Doxa" credit sits in the footer, on the brand row.
 */
export function ArticleEnd(props: ComponentProps<typeof Pagination>) {
  // `empty:hidden` drops the top margin when the page has no neighbors.
  return (
    <div className="not-prose mt-12 flex flex-col gap-3 empty:hidden">
      <Pagination {...props} />
    </div>
  );
}
