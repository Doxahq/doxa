import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { LuSearch } from "react-icons/lu";

const SearchDialog = lazy(() => import("@/src/components/navigation/search"));

/** `compact`: a narrower box for the right side of the top bar. */
export default function SearchTrigger({
  compact = false,
}: {
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openSearch = useCallback(() => {
    setHasOpened(true);
    setIsOpen(true);
  }, []);

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }

      event.preventDefault();
      if (isOpen) {
        handleOpenChange(false);
      } else {
        openSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleOpenChange, isOpen, openSearch]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open search"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={openSearch}
        className={
          compact
            ? "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border bg-background text-left text-sm text-muted-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-[180px] sm:justify-start sm:pr-2 sm:pl-9 xl:w-[220px]"
            : "relative flex h-9 w-full max-w-md cursor-pointer items-center rounded-md border bg-background pr-2 pl-10 text-left text-sm text-muted-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-[260px] md:w-[320px] lg:w-[420px]"
        }
      >
        <LuSearch
          className={
            compact
              ? "h-4 w-4 sm:absolute sm:top-1/2 sm:left-3 sm:-translate-y-1/2"
              : "absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
          }
        />
        <span className={compact ? "hidden flex-1 sm:block" : "flex-1"}>
          {compact ? "Search..." : "Search documentation..."}
        </span>
        <kbd className="pointer-events-none hidden h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>
      {hasOpened && (
        <Suspense fallback={null}>
          <SearchDialog isOpen={isOpen} onOpenChange={handleOpenChange} />
        </Suspense>
      )}
    </>
  );
}
