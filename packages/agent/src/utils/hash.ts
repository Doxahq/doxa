import { sha256String } from "./runtime";
import { stableStringify } from "./stable-hash";

export { stableStringify };

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;

  if (globalThis.crypto?.subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashValue(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

export function hashObject(value: unknown): string {
  return sha256String(stableStringify(value));
}
