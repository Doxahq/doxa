import { resolveEmbedUrl } from "@doxahq/mdx-runtime";

export interface EmbedProps {
  /** The video address, for example `https://youtu.be/…`. */
  url?: string;
  /** The iframe title for screen readers. Defaults to the provider name. */
  title?: string;
}

/**
 * A YouTube, Vimeo, or Loom video in a 16:9 frame.
 *
 * Any other address renders as a plain link, so a page never embeds an
 * unknown site and a reader can still follow the address.
 */
export function Embed({ url = "", title }: EmbedProps) {
  const embed = resolveEmbedUrl(url);

  if (!embed) {
    return /^https?:\/\//i.test(url) ? (
      <p>
        <a href={url} rel="noopener noreferrer" target="_blank">
          {title || url}
        </a>
      </p>
    ) : null;
  }

  return (
    <div className="not-prose my-6 aspect-video w-full overflow-hidden rounded-md">
      <iframe
        src={embed.src}
        title={title || embed.label}
        className="h-full w-full border-0"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  );
}
