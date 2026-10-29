import type { WarmPoolLocationHint } from "@doxahq/contracts/docs-warm-region";

/**
 * The part of Durable Object storage that the warm objects use. The state
 * machines take this interface, so tests run them on an in-memory stub.
 * `DurableObjectStorage` satisfies it.
 */
export interface WarmStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The part of a Durable Object namespace that the warm job uses. */
export interface WarmNamespace<Stub> {
  idFromName(name: string): DurableObjectId;
  get(
    id: DurableObjectId,
    options?: { locationHint?: WarmPoolLocationHint },
  ): Stub;
}

/** Reads a stored value through a parser; anything unparsable reads as null. */
export async function readStored<T>(
  storage: Pick<WarmStorage, "get">,
  key: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  const value = await storage.get(key);
  return value === undefined ? null : parse(value);
}
