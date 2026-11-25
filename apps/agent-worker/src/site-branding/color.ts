/** sRGB channels, 0 to 255. */
export type Rgb = readonly [number, number, number];

const NAMED: Record<string, Rgb> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
};

/**
 * Parses the color notations that logos and site tokens use: hex, rgb(),
 * hsl() and oklch(). Returns null for anything else (gradients, currentColor).
 */
export function parseColor(input: string | null | undefined): Rgb | null {
  if (!input) return null;
  const value = input.trim().toLowerCase().replace(/\s*!important$/, "");
  const named = NAMED[value];
  if (named) return named;
  let match = value.match(/^#([0-9a-f]{3,8})$/);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      hex = [...hex.slice(0, 3)].map((digit) => digit + digit).join("");
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (match) {
    return [match[1], match[2], match[3]].map((channel) =>
      Math.round(Math.min(255, Number(channel))),
    ) as unknown as Rgb;
  }
  match = value.match(/^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (match) return hslToRgb(Number(match[1]), Number(match[2]), Number(match[3]));
  match = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/);
  if (match) {
    const lightness = match[2] ? Number(match[1]) / 100 : Number(match[1]);
    return oklchToRgb(lightness, Number(match[3]), Number(match[4]));
  }
  return null;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as unknown as Rgb;
}

function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((v) => {
    const encoded =
      v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  }) as unknown as Rgb;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function toLab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Black, white and greys, including tinted near-greys. */
export function isNeutral(rgb: Rgb): boolean {
  const [, a, b] = toLab(rgb);
  return Math.hypot(a, b) < 12;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
