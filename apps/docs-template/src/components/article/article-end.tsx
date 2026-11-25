import type { ComponentProps } from "react";
import { useDemoMode } from "@/src/contexts/demo-mode";
import { useSiteConfig } from "@/src/site-config/site-config-context";

import { Pagination } from "@/src/components/article/pagination";
import { PoweredByDoxa } from "@/src/components/navigation/powered-by-doxa";

/**
 * The end of the article, above the footer: the "Powered by Doxa" credit on the
 * right, over the next page card, then the cards to the previous and the next
 * page. The demo hides the credit, like the footer.
 */
export function ArticleEnd(props: ComponentProps<typeof Pagination>) {
  const { branding } = useSiteConfig();
  const isDemoMode = useDemoMode();
  const showCredit = branding.poweredBy && !isDemoMode;

  // `empty:hidden` drops the top margin when there is neither a credit nor a card.
  return (
    <div className="not-prose mt-12 flex flex-col gap-3 empty:hidden">
      {showCredit && <PoweredByDoxa className="self-end" />}
      <Pagination {...props} />
    </div>
  );
}
