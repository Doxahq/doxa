import { z } from "zod";

const number = "([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))";
const channel = `${number}(%)?`;
const hue = `${number}(deg)?`;
const alpha = `(?:\\s*/\\s*${channel})?`;
const hex = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const rgbSpace = new RegExp(
  `^rgba?\\(${channel} +${channel} +${channel}${alpha}\\)$`,
);
const rgbComma = new RegExp(
  `^rgba?\\(${channel}, *${channel}, *${channel}(?:, *${channel})?\\)$`,
);
const hslSpace = new RegExp(
  `^hsla?\\(${hue} +${number}% +${number}%${alpha}\\)$`,
);
const hslComma = new RegExp(
  `^hsla?\\(${hue}, *${number}%, *${number}%(?:, *${channel})?\\)$`,
);
const lch = new RegExp(`^oklch\\(${channel} +${channel} +${hue}${alpha}\\)$`);
const lab = new RegExp(
  `^oklab\\(${channel} +${channel} +${channel}${alpha}\\)$`,
);

function exactMatch(value: string, pattern: RegExp): RegExpMatchArray | null {
  const match = value.match(pattern);
  return match?.[0] === value ? match : null;
}

function bounded(value: string | undefined, max: number, min = 0): boolean {
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function validAlpha(
  value: string | undefined,
  percent: string | undefined,
): boolean {
  return value === undefined || bounded(value, percent ? 100 : 1);
}

function validRgb(match: RegExpMatchArray): boolean {
  return (
    [1, 3, 5].every((index) =>
      bounded(match[index], match[index + 1] ? 100 : 255),
    ) && validAlpha(match[7], match[8])
  );
}

function validHsl(match: RegExpMatchArray): boolean {
  return (
    bounded(match[1], 360, -360) &&
    bounded(match[3], 100) &&
    bounded(match[4], 100) &&
    validAlpha(match[5], match[6])
  );
}

export function isCssColor(value: string): boolean {
  if (value.length > 64) return false;
  if (exactMatch(value, hex)) return true;
  const rgb = exactMatch(value, rgbSpace) ?? exactMatch(value, rgbComma);
  if (rgb) return validRgb(rgb);
  const hsl = exactMatch(value, hslSpace) ?? exactMatch(value, hslComma);
  if (hsl) return validHsl(hsl);
  const oklch = exactMatch(value, lch);
  if (oklch) {
    return (
      bounded(oklch[1], oklch[2] ? 100 : 1) &&
      bounded(oklch[3], oklch[4] ? 100 : 0.4) &&
      bounded(oklch[5], 360, -360) &&
      validAlpha(oklch[7], oklch[8])
    );
  }
  const oklab = exactMatch(value, lab);
  return (
    oklab !== null &&
    bounded(oklab[1], oklab[2] ? 100 : 1) &&
    bounded(oklab[3], oklab[4] ? 100 : 0.4, oklab[4] ? -100 : -0.4) &&
    bounded(oklab[5], oklab[6] ? 100 : 0.4, oklab[6] ? -100 : -0.4) &&
    validAlpha(oklab[7], oklab[8])
  );
}

export const cssColorSchema = z.string().refine(isCssColor, {
  params: { siteConfigCode: "invalid_color" },
});
