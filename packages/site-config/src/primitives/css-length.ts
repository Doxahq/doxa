import { z } from "zod";

const length = /^(\d+(?:\.\d+)?|\.\d+)(rem|px)$/;

export function isCssLength(value: string): boolean {
  if (value.length > 64) return false;
  if (value === "0") return true;
  const match = value.match(length);
  return (
    match !== null &&
    match[0] === value &&
    Number(match[1]) <= (match[2] === "rem" ? 4 : 64)
  );
}

export const cssLengthSchema = z.string().refine(isCssLength, {
  params: { siteConfigCode: "invalid_length" },
});
