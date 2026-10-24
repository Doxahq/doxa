import { z } from "zod";

const DEFAULT_GENERATION_PAGE_LIMIT = 20;
const MAX_GENERATION_PAGE_LIMIT = 50;
const MAX_GENERATION_CURSOR_LENGTH = 512;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const generationCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

export interface GenerationCursorPosition {
  createdAt: string;
  id: string;
}

export interface GenerationPageRequest {
  limit: number;
  cursor: GenerationCursorPosition | null;
}

export type GenerationPageRequestResult =
  | { ok: true; value: GenerationPageRequest }
  | { ok: false; message: string };

export function parseGenerationPageRequest(url: URL): GenerationPageRequestResult {
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return { ok: false, message: "Invalid generation page limit." };
  }

  const encodedCursor = url.searchParams.get("cursor");
  if (!encodedCursor) {
    return { ok: true, value: { limit, cursor: null } };
  }

  const cursor = decodeGenerationCursor(encodedCursor);
  return cursor
    ? { ok: true, value: { limit, cursor } }
    : { ok: false, message: "Invalid generation cursor." };
}

export function encodeGenerationCursor(position: GenerationCursorPosition): string {
  const payload = generationCursorSchema.parse({
    createdAt: position.createdAt,
    id: position.id,
  });

  return encodeBase64Url(JSON.stringify(payload));
}

function parseLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_GENERATION_PAGE_LIMIT;
  if (!/^-?\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;

  return Math.min(MAX_GENERATION_PAGE_LIMIT, Math.max(1, parsed));
}

function decodeGenerationCursor(value: string): GenerationCursorPosition | null {
  if (value.length > MAX_GENERATION_CURSOR_LENGTH || !BASE64_URL_PATTERN.test(value)) {
    return null;
  }

  try {
    const parsedJson: unknown = JSON.parse(decodeBase64Url(value));
    const parsedCursor = generationCursorSchema.safeParse(parsedJson);
    if (!parsedCursor.success) return null;

    return {
      createdAt: parsedCursor.data.createdAt,
      id: parsedCursor.data.id,
    };
  } catch {
    return null;
  }
}

function encodeBase64Url(value: string): string {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(`${normalized}${padding}`);
}
