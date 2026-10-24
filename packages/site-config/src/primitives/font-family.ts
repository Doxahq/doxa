import { z } from "zod";
import { FONT_CATALOG } from "../fonts";

export const fontFamilySchema = z
  .enum(Object.keys(FONT_CATALOG))
  .refine(
    (value): value is keyof typeof FONT_CATALOG =>
      Object.hasOwn(FONT_CATALOG, value),
    { params: { siteConfigCode: "unknown_font" } },
  );

export function fontDefinition(name: string) {
  return Object.entries(FONT_CATALOG).find(([family]) => family === name)?.[1];
}
