const MIN_SECRET_LENGTH = 32;

/**
 * Compares a presented key with the expected one in time that does not
 * depend on where they differ. Node's Web Crypto has no `timingSafeEqual`,
 * so both runtimes use this.
 */
export function secretsMatch(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(presented);
  const b = encoder.encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index++) {
    difference |= (a[index] ?? 0) ^ b[index]!;
  }
  return difference === 0;
}

/** Rejects a missing or short key at start-up, instead of on the first request. */
export function assertStrongSecret(name: string, value: string | undefined): string {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be set to a random value of at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return value;
}
