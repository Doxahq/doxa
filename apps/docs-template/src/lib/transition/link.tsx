import {
  useCallback,
  useMemo,
  useRef,
  type ComponentProps,
  type MouseEvent,
} from "react";
import {
  Link as RouterLink,
  useNavigate,
  useRouter,
  useSearch,
} from "@tanstack/react-router";

import { useDeferredViewportPreload } from "@/src/lib/deferred-preload";
import { startViewTransitionIfSupported } from "@/src/lib/transition/document-view-transition";

function isModifiedEvent(event: MouseEvent): boolean {
  const eventTarget = event.currentTarget as HTMLAnchorElement | SVGAElement;
  const target = eventTarget.getAttribute("target");
  return (
    (target && target !== "_self") ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (event.nativeEvent && event.button === 1)
  );
}

function shouldPreserveDefault(e: MouseEvent<HTMLAnchorElement>): boolean {
  const { nodeName } = e.currentTarget;

  const isAnchorNodeName = nodeName.toUpperCase() === "A";

  if (isAnchorNodeName && isModifiedEvent(e)) {
    return true;
  }

  return false;
}

interface LinkProps extends Omit<ComponentProps<"a">, "href"> {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  preload?: ComponentProps<typeof RouterLink>["preload"];
  preloadDelay?: ComponentProps<typeof RouterLink>["preloadDelay"];
  /** Preload when visible, after the page has loaded. See `deferred-preload.ts`. */
  deferredViewportPreload?: boolean;
}

export function Link({
  href,
  onClick,
  preload,
  preloadDelay,
  deferredViewportPreload = false,
  replace,
  scroll,
  children,
  ...rest
}: LinkProps) {
  const navigate = useNavigate();
  const router = useRouter();
  const rootSearch = useSearch({ from: "__root__" });
  const isDemo = Boolean(rootSearch.demo);
  const demoSearch = useMemo(
    () => (isDemo ? { demo: true as const } : undefined),
    [isDemo]
  );
  const isExternal = href.startsWith("http") || href.startsWith("//");
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const preloadRoute = useCallback(
    () => router.preloadRoute({ to: href, search: demoSearch }),
    [router, href, demoSearch]
  );
  useDeferredViewportPreload(anchorRef, {
    enabled: deferredViewportPreload && !isExternal,
    key: demoSearch ? `${href}?demo` : href,
    preload: preloadRoute,
  });

  // Handle external links
  if (isExternal) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  const handleClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (onClick) {
        onClick(e);
      }

      if (e.defaultPrevented) {
        return;
      }

      if ("startViewTransition" in document) {
        if (shouldPreserveDefault(e)) {
          return;
        }

        e.preventDefault();

        startViewTransitionIfSupported(() => {
          navigate({
            to: href,
            replace,
            resetScroll: scroll,
            search: demoSearch,
          });
        });
      }
    },
    [onClick, href, replace, scroll, navigate, demoSearch]
  );

  return (
    <RouterLink
      ref={anchorRef}
      to={href}
      onClick={handleClick}
      preload={preload}
      preloadDelay={preloadDelay}
      resetScroll={scroll}
      search={demoSearch}
      {...rest}
    >
      {children}
    </RouterLink>
  );
}
