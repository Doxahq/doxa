import { cn } from "@/src/lib/utils";
import {
  LogoMark,
  WORDMARK_FONT_STYLE,
} from "@/src/components/navigation/logo";

const DOXA_HOME_URL = "https://doxa.so";

/**
 * The "Powered by Doxa" credit. Free plans always show it. Paid plans show it
 * until the site turns off `branding.poweredBy`.
 */
export function PoweredByDoxa({ className }: { className?: string }) {
  return (
    <a
      href={DOXA_HOME_URL}
      rel="noopener noreferrer"
      className={cn(
        // A pill that follows the theme radius: square when the radius is 0.
        "inline-flex h-7 items-center gap-1.5 rounded-[calc(var(--radius)*100)] border px-2.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground",
        className
      )}
    >
      Powered by
      <LogoMark size={10} doxa />
      <span
        className="-ml-0.5 font-semibold text-foreground"
        style={WORDMARK_FONT_STYLE}
      >
        doxa
      </span>
    </a>
  );
}
