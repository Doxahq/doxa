import { describe, expect, test } from "vitest";

import {
  clampView,
  fitSize,
  maxScale,
  transformFromRect,
  wheelZoomFactor,
  zoomAt,
} from "./image-zoom";

const viewport = { width: 1000, height: 800 };

describe("image viewer geometry", () => {
  test("fits a large image inside the viewport margins, keeping its shape", () => {
    const fitted = fitSize({ width: 4000, height: 2000 }, viewport);
    expect(fitted.width).toBeCloseTo(920);
    expect(fitted.height).toBeCloseTo(460);
  });

  test("keeps a small image at its own size", () => {
    expect(fitSize({ width: 200, height: 100 }, viewport)).toEqual({ width: 200, height: 100 });
  });

  test("lets a large screenshot zoom to twice its own pixels", () => {
    expect(maxScale({ width: 4000, height: 2000 }, { width: 920, height: 460 })).toBeCloseTo(8.7, 1);
    expect(maxScale({ width: 200, height: 100 }, { width: 200, height: 100 })).toBe(4);
  });

  test("zooming keeps the point under the pointer in place", () => {
    const focus = { x: 100, y: -50 };
    const view = zoomAt({ scale: 1, x: 0, y: 0 }, 2, focus);
    // The image point under the focus, before and after.
    const before = { x: (focus.x - 0) / 1, y: (focus.y - 0) / 1 };
    const after = { x: (focus.x - view.x) / view.scale, y: (focus.y - view.y) / view.scale };
    expect(after).toEqual(before);
  });

  test("a fitted image stays centered and a zoomed one cannot leave the viewport", () => {
    const fitted = { width: 920, height: 460 };
    expect(clampView({ scale: 1, x: 300, y: -200 }, fitted, viewport, 8)).toEqual({ scale: 1, x: 0, y: 0 });

    const zoomed = clampView({ scale: 2, x: 5000, y: 5000 }, fitted, viewport, 8);
    expect(zoomed).toEqual({ scale: 2, x: 420, y: 60 });
  });

  test("the scale stays between the fitted size and the maximum", () => {
    const fitted = { width: 920, height: 460 };
    expect(clampView({ scale: 0.3, x: 0, y: 0 }, fitted, viewport, 8).scale).toBe(1);
    expect(clampView({ scale: 20, x: 0, y: 0 }, fitted, viewport, 8).scale).toBe(8);
  });

  test("the wheel zooms in when scrolled up and a pinch zooms faster", () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
    // One line of a mouse wheel is not a giant jump.
    expect(wheelZoomFactor(-3, 1, false)).toBeLessThan(1.2);
  });

  test("the viewer starts from the exact place of the page image", () => {
    const fitted = { width: 920, height: 460 };
    const rect = { left: 100, top: 200, width: 460, height: 230 };
    expect(transformFromRect(rect, fitted, viewport)).toBe(
      "translate3d(-170px, -85px, 0) scale(0.5)",
    );
  });
});
