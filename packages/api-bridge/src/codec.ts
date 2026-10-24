import { parse, stringify } from "devalue";

/**
 * Encodes the values that Workers RPC carries and JSON does not: `Date`,
 * `Map`, `Set`, `undefined`, `BigInt`, `ArrayBuffer` and typed arrays, and
 * repeated or circular references. Functions, streams and class instances
 * are not supported, as with Workers RPC between Workers of one account.
 */
export function encodeValue(value: unknown): string {
  return stringify(value);
}

export function decodeValue(text: string): unknown {
  return parse(text);
}

/** The result of one remote call: its value, or the error that it threw. */
export type RemoteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: RemoteErrorInfo };

export interface RemoteErrorInfo {
  readonly name: string;
  readonly message: string;
}

/** Workers RPC keeps the name and message of a thrown error. So does this. */
export function toRemoteErrorInfo(cause: unknown): RemoteErrorInfo {
  if (cause instanceof Error) return { name: cause.name, message: cause.message };
  return { name: "Error", message: String(cause) };
}

/** An error that a remote call threw, with the remote name and message. */
export class RemoteCallError extends Error {
  constructor(info: RemoteErrorInfo) {
    super(info.message);
    this.name = info.name;
  }
}

export function encodeResult(result: RemoteResult): string {
  return encodeValue(result);
}

export function decodeResult(text: string): RemoteResult {
  const decoded = decodeValue(text);
  if (isRemoteResult(decoded)) return decoded;
  throw new Error("The remote call returned a body that is not a call result.");
}

export function decodeArguments(text: string): unknown[] {
  const decoded = decodeValue(text);
  if (Array.isArray(decoded)) return decoded;
  throw new Error("The call arguments must be an array.");
}

function isRemoteResult(value: unknown): value is RemoteResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "value" in value;
  return (
    value.ok === false &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "name" in value.error &&
    typeof value.error.name === "string" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  );
}
