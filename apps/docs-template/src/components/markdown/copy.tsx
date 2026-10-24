import { useState, type ReactNode } from "react";
import { LuCheck, LuCopy } from "react-icons/lu";

import { cn } from "@/src/lib/utils";
import { Button } from "@/src/components/ui/button";

export default function Copy({
  content,
  children,
  label = "Copy to clipboard",
  className,
}: {
  content: string;
  children?: ReactNode;
  label?: string;
  className?: string;
}) {
  const [isCopied, setIsCopied] = useState(false);
  const iconOnly = children === undefined;

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setIsCopied(true);

    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={iconOnly ? "icon" : "default"}
      aria-label={label}
      title={label}
      onClick={handleCopy}
      className={cn(
        "relative cursor-pointer",
        iconOnly && "size-8!",
        className
      )}
    >
      {children}
      <span
        data-copy-icon-container="true"
        className="relative size-3.5 shrink-0"
      >
        <LuCopy
          className={cn(
            "absolute inset-0 size-3.5! transform transition-opacity duration-75",
            isCopied ? "scale-90 opacity-0" : "scale-100 opacity-100"
          )}
        />
        <LuCheck
          className={cn(
            "absolute inset-0 size-3.5! transform transition-opacity duration-75",
            isCopied ? "scale-100 opacity-100" : "scale-90 opacity-0"
          )}
        />
      </span>
    </Button>
  );
}
