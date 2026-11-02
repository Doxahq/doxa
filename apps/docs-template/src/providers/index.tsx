import { useSiteConfig } from "@/src/site-config/site-config-context";

import { ViewTransitions } from "@/src/lib/transition";
import { ColorProvider } from "@/src/providers/color";
import { ThemeProvider } from "@/src/providers/theme";
import { RouteIconsProvider } from "@/src/components/docs-icon";

export const Providers: React.FC<{
  children: React.ReactNode;
  /** The mark of this render: the theme provider writes an inline script. */
  scriptMark?: string;
}> = ({ children, scriptMark }) => {
  const { theme } = useSiteConfig();
  const isDarkOnly = theme.colorMode === "dark-only";
  return (
    <ThemeProvider
      nonce={scriptMark}
      attribute="class"
      defaultTheme={isDarkOnly ? "dark" : theme.defaultMode}
      enableSystem={!isDarkOnly}
      forcedTheme={isDarkOnly ? "dark" : undefined}
    >
      <ColorProvider>
        <ViewTransitions>
          <RouteIconsProvider>{children}</RouteIconsProvider>
        </ViewTransitions>
      </ColorProvider>
    </ThemeProvider>
  );
};
