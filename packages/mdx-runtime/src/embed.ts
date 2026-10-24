/**
 * Video embeds for `<Embed url="…" />`.
 *
 * A page names the address a reader copies from the browser, such as
 * `https://youtu.be/abc` or `https://www.loom.com/share/abc`. The renderer
 * turns it into the player address of the provider. Only these providers
 * load: an iframe of any other address would let a page embed any site.
 */

export const EMBED_PROVIDERS = ["youtube", "vimeo", "loom"] as const;

export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

export interface ResolvedEmbed {
  provider: EmbedProvider;
  /** The player address for the iframe. */
  src: string;
  /** A provider name for the iframe title. */
  label: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[a-f0-9]{6,20}$/;
const LOOM_ID = /^[a-f0-9]{32}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** The player of a supported video address, or null for any other address. */
export function resolveEmbedUrl(input: string): ResolvedEmbed | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be" || YOUTUBE_HOSTS.has(host)) {
    return youtube(host, segments, url.searchParams);
  }
  if (host === "vimeo.com" || host === "www.vimeo.com") {
    return vimeo(segments[0], segments[1] ?? url.searchParams.get("h"));
  }
  if (host === "player.vimeo.com" && segments[0] === "video") {
    return vimeo(segments[1], url.searchParams.get("h"));
  }
  if (
    (host === "loom.com" || host === "www.loom.com") &&
    (segments[0] === "share" || segments[0] === "embed") &&
    segments[1] &&
    LOOM_ID.test(segments[1])
  ) {
    return {
      provider: "loom",
      src: `https://www.loom.com/embed/${segments[1]}`,
      label: "Loom video",
    };
  }
  return null;
}

function youtube(
  host: string,
  segments: string[],
  query: URLSearchParams,
): ResolvedEmbed | null {
  const id =
    host === "youtu.be"
      ? segments[0]
      : segments[0] === "watch"
        ? query.get("v")
        : segments[0] === "embed" ||
            segments[0] === "shorts" ||
            segments[0] === "live"
          ? segments[1]
          : undefined;
  if (!id || !YOUTUBE_ID.test(id)) return null;

  const start = readYoutubeStart(query.get("t") ?? query.get("start"));
  return {
    provider: "youtube",
    src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ""}`,
    label: "YouTube video",
  };
}

/** `t=90`, `t=90s`, or `t=1m30s`, in whole seconds. */
function readYoutubeStart(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
  if (!match || match[0] === "") return null;
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

function vimeo(
  id: string | undefined,
  hash: string | null | undefined,
): ResolvedEmbed | null {
  if (!id || !VIMEO_ID.test(id)) return null;
  const privateHash = hash && VIMEO_HASH.test(hash) ? `?h=${hash}` : "";
  return {
    provider: "vimeo",
    src: `https://player.vimeo.com/video/${id}${privateHash}`,
    label: "Vimeo video",
  };
}
