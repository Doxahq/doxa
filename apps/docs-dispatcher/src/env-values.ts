export function requireEnvValue(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim();
  if (normalized) return normalized;
  throw new Error(`Missing required dispatcher variable: ${name}.`);
}
