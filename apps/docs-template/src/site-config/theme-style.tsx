import {
  fontStylesheetHref,
  themeToCss,
  type ResolvedTheme,
} from "@doxahq/site-config";

const cssCache = new Map<string, string>();

function cachedCss(hash: string, theme: ResolvedTheme): string {
  const existing = cssCache.get(hash);
  if (existing !== undefined) {
    cssCache.delete(hash);
    cssCache.set(hash, existing);
    return existing;
  }
  const css = themeToCss(theme);
  cssCache.set(hash, css);
  if (cssCache.size > 256) {
    const first = cssCache.keys().next().value;
    if (first !== undefined) cssCache.delete(first);
  }
  return css;
}

export function ThemeStyle({
  theme,
  configHash,
}: {
  theme: ResolvedTheme;
  configHash: string;
}) {
  const href = fontStylesheetHref(theme);
  return (
    <>
      <style
        dangerouslySetInnerHTML={{ __html: cachedCss(configHash, theme) }}
      />
      {href && (
        <>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link
            rel="preconnect"
            href="https://fonts.gstatic.com"
            crossOrigin="anonymous"
          />
          <link rel="stylesheet" href={href} />
        </>
      )}
    </>
  );
}
