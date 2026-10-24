import { useState, type ComponentProps, type ComponentType } from "react";

import { cn } from "../lib/cn";

export interface PreIcons {
  copy: ComponentType<{ className?: string }>;
  copied: ComponentType<{ className?: string }>;
}

export type PreProps = ComponentProps<"pre"> & {
  raw?: string;
  "data-language"?: string;
};

/**
 * The published docs' outline icon button, written out so the editor draws the
 * same control without the docs renderer's button component.
 */
const COPY_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 size-9 relative cursor-pointer size-8!";

const COPY_LABEL = "Copy to clipboard";

/**
 * Builds the code fence wrapper around a host's icon set: the language label
 * and a copy button over the highlighted `<pre>`.
 *
 * The inner `<pre>` is left as the parser produced it, so the shared
 * `.prose-content` rules lay it out and Shiki's inline variables color it.
 */
export function createPre(icons: PreIcons): ComponentType<PreProps> {
  const { copy: CopyIcon, copied: CopiedIcon } = icons;

  function CopyButton({ content }: { content: string }) {
    const [isCopied, setIsCopied] = useState(false);

    async function handleCopy() {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }

    return (
      <button
        data-slot="button"
        className={COPY_BUTTON_CLASS}
        type="button"
        aria-label={COPY_LABEL}
        title={COPY_LABEL}
        onClick={handleCopy}
      >
        <span
          data-copy-icon-container="true"
          className="relative size-3.5 shrink-0"
        >
          <CopyIcon
            className={cn(
              "absolute inset-0 size-3.5! transform transition-opacity duration-75",
              isCopied ? "scale-90 opacity-0" : "scale-100 opacity-100",
            )}
          />
          <CopiedIcon
            className={cn(
              "absolute inset-0 size-3.5! transform transition-opacity duration-75",
              isCopied ? "scale-100 opacity-100" : "scale-90 opacity-0",
            )}
          />
        </span>
      </button>
    );
  }

  return function Pre({
    children,
    raw,
    "data-language": language,
    ...rest
  }: PreProps) {
    return (
      <div className="relative my-5">
        {language || raw !== undefined ? (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-2 sm:top-3 sm:right-2.5">
            {language ? (
              <span
                data-code-language="true"
                className="font-mono text-xs text-muted-foreground"
              >
                {language}
              </span>
            ) : null}
            {raw !== undefined ? <CopyButton content={raw} /> : null}
          </div>
        ) : null}
        <div className="relative">
          <pre {...rest} data-language={language}>
            {children}
          </pre>
        </div>
      </div>
    );
  };
}
