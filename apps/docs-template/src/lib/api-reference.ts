export type ApiMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export function normalizeApiMethod(
  value: string | undefined
): ApiMethod | undefined {
  switch (value?.trim().toUpperCase()) {
    case "GET":
      return "GET";
    case "POST":
      return "POST";
    case "PUT":
      return "PUT";
    case "PATCH":
      return "PATCH";
    case "DELETE":
      return "DELETE";
    case "HEAD":
      return "HEAD";
    case "OPTIONS":
      return "OPTIONS";
    default:
      return undefined;
  }
}

export function formatApiTitle(
  title: string,
  method: string | undefined
): string {
  const normalizedMethod = normalizeApiMethod(method);
  if (!normalizedMethod) return title;
  return new RegExp(`^${normalizedMethod}\\s+(?:/|https?://)`, "i").test(title)
    ? title
    : `${normalizedMethod} ${title}`;
}
