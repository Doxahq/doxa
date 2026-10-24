export function normalizeDocsHostname(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hostname = extractHostname(trimmed).replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.includes("..")) return null;

  const labels = hostname.split(".");
  const labelsAreValid = labels.every(isValidHostnameLabel);
  return labelsAreValid ? hostname : null;
}

function extractHostname(input: string): string {
  if (input.includes("://")) {
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }

  const withoutPath = input.split("/", 1)[0] ?? "";
  return stripPort(withoutPath);
}

function stripPort(hostname: string): string {
  const colonCount = hostname.split(":").length - 1;
  if (colonCount !== 1) return hostname;

  const [host, port] = hostname.split(":");
  return host && /^\d+$/.test(port ?? "") ? host : hostname;
}

function isValidHostnameLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}
