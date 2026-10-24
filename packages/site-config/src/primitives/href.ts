import { z } from "zod";

const unsafeCharacters = /[\s\\\u0000-\u001f\u007f-\u009f]/;
const permittedProtocols: ReadonlySet<string> = new Set([
  "https:",
  "http:",
  "mailto:",
]);

function hrefIssue(
  value: string,
): "invalid_href" | "unsafe_href_protocol" | null {
  if (!value || value.length > 2048 || unsafeCharacters.test(value))
    return "invalid_href";
  if (value.startsWith("//")) return "invalid_href";
  if (value.startsWith("/")) return null;
  try {
    return permittedProtocols.has(new URL(value).protocol)
      ? null
      : "unsafe_href_protocol";
  } catch {
    return "invalid_href";
  }
}

// These are the existing normalizeRuntimeHref rules. Apps adopt this shared
// primitive when the readers move to site config in phase 2.
function normalizeInternalHref(value: string): string {
  const clean = value
    .split(/[?#]/, 1)[0]
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/(?:^|\/)index(?:\.mdx?)?$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return clean ? `/${clean}` : "/";
}

export const hrefSchema = z
  .string()
  .superRefine((value, ctx) => {
    const code = hrefIssue(value);
    if (code)
      ctx.addIssue({ code: "custom", params: { siteConfigCode: code } });
  })
  .transform((value) =>
    value.startsWith("/") ? normalizeInternalHref(value) : value,
  );

export const socialHrefSchema = hrefSchema.refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { params: { siteConfigCode: "unsafe_href_protocol" } },
);
