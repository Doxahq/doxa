const UNIQUE_VIOLATION = "23505";

/**
 * True when `error`, or an error in its `cause` chain, is a Postgres unique
 * violation. With `constraint`, only a violation of that index matches.
 * Drivers and Drizzle wrap the database error, so the chain is walked.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const visited = new Set<object>();
  let current = error;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const hasMatchingCode = Reflect.get(current, "code") === UNIQUE_VIOLATION;
    const hasMatchingConstraint =
      constraint === undefined ||
      Reflect.get(current, "constraint") === constraint;
    if (hasMatchingCode && hasMatchingConstraint) return true;
    current = Reflect.get(current, "cause");
  }

  return false;
}
