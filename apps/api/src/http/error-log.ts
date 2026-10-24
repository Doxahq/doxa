export interface SafeErrorLog {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  constraint?: string;
}

interface DatabaseErrorDetails {
  code: string | null;
  constraint: string | null;
  isQueryError: boolean;
}

export function toSafeErrorLog(error: unknown): SafeErrorLog {
  const name = readString(error, "name") ?? "UnknownError";
  const databaseError = findDatabaseError(error);
  const message = databaseError.isQueryError
    ? "Database query failed."
    : readString(error, "message") ?? "An unknown error occurred.";
  const stack = readStackFrames(error);

  return {
    name,
    message,
    ...(stack ? { stack } : {}),
    ...(databaseError.code ? { code: databaseError.code } : {}),
    ...(databaseError.constraint
      ? { constraint: databaseError.constraint }
      : {}),
  };
}

function findDatabaseError(error: unknown): DatabaseErrorDetails {
  const details: DatabaseErrorDetails = {
    code: null,
    constraint: null,
    isQueryError: false,
  };

  for (const link of causeChain(error)) {
    if (!details.code) details.code = readString(link, "code");
    if (!details.constraint) {
      details.constraint = readString(link, "constraint");
    }
    if (isDatabaseQueryError(link)) details.isQueryError = true;
  }

  return details;
}

function isDatabaseQueryError(value: unknown): boolean {
  return readString(value, "query") !== null
    && Array.isArray(readValue(value, "params"));
}

function* causeChain(error: unknown): Generator<unknown> {
  const visited = new Set<object>();
  let current = error;

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    yield current;
    current = readValue(current, "cause");
  }
}

function readStackFrames(error: unknown): string | null {
  const stack = readString(error, "stack");
  if (!stack) return null;

  const frames = stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line));

  return frames.length > 0 ? frames.join("\n") : null;
}

function readString(value: unknown, key: string): string | null {
  const property = readValue(value, key);
  return typeof property === "string" && property.length > 0
    ? property
    : null;
}

function readValue(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Reflect.get(value, key)
    : undefined;
}
