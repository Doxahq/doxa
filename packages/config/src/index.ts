export function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}
