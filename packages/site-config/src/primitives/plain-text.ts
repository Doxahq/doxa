import { z } from "zod";

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;

/** Derived defaults can come from older, less restrictive project names. */
export function normalizeDefaultText(value: string, max: number): string {
  const text = value
    .replace(new RegExp(controlCharacters.source, "g"), "")
    .trim();
  let result = "";
  for (const character of text) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result.trim();
}

/**
 * Text that a reader sees as a link or a heading. An empty value renders as an
 * invisible link, so it is rejected with the `required` code.
 */
export function requiredTextSchema(max: number) {
  return plainTextSchema(max).min(1)
}

export function plainTextSchema(max: number) {
  return z
    .string()
    .refine((value) => !controlCharacters.test(value), {
      params: { siteConfigCode: "invalid_text" },
    })
    .trim()
    .max(max);
}
