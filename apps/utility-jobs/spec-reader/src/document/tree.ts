/**
 * A value of a parsed spec document. Objects have no prototype, and an
 * integer that a JavaScript number cannot hold exactly is a bigint.
 */
export type SpecValue = string | number | bigint | boolean | null | SpecArray | SpecObject;
export type SpecArray = readonly SpecValue[];
export interface SpecObject {
  readonly [key: string]: SpecValue;
}

export function isSpecObject(value: SpecValue | undefined): value is SpecObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSpecArray(value: SpecValue | undefined): value is SpecArray {
  return Array.isArray(value);
}

/** The own value of a key. Spec objects have no prototype, so nothing is inherited. */
export function valueAt(object: SpecObject, key: string): SpecValue | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export function stringAt(object: SpecObject, key: string): string | undefined {
  const value = valueAt(object, key);
  return typeof value === "string" ? value : undefined;
}

export function objectAt(object: SpecObject, key: string): SpecObject | undefined {
  const value = valueAt(object, key);
  return isSpecObject(value) ? value : undefined;
}

export function arrayAt(object: SpecObject, key: string): SpecArray | undefined {
  const value = valueAt(object, key);
  return isSpecArray(value) ? value : undefined;
}

export function isTrue(object: SpecObject, key: string): boolean {
  return valueAt(object, key) === true;
}

/** The keys and values of an object, in document order. */
export function entriesOf(object: SpecObject): [string, SpecValue][] {
  return Object.entries(object);
}
