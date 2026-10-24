/**
 * The geometry of the image viewer.
 *
 * The image sits centered in the viewport at its fitted size. A view moves
 * it with `translate(x, y) scale(scale)` around its center. Scale 1 is the
 * fitted size; the viewer zooms between `MIN_SCALE` and `maxScale`.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

export const FIT_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

export const MIN_SCALE = 1;

/** The room the viewer keeps around a fitted image, as a share of the viewport. */
const FIT_MARGIN = { width: 0.92, height: 0.86 };

/** Each zoom button press or key press multiplies the scale by this. */
export const ZOOM_STEP = 1.6;

/** A click on a fitted image zooms to this scale. */
export const CLICK_ZOOM = 2.5;

/**
 * The size that shows the whole image in the viewport. A small image keeps
 * its own size: enlarging it would only blur it.
 */
export function fitSize(natural: Size, viewport: Size): Size {
  const width = Math.max(1, natural.width);
  const height = Math.max(1, natural.height);
  const ratio = Math.min(
    1,
    (viewport.width * FIT_MARGIN.width) / width,
    (viewport.height * FIT_MARGIN.height) / height,
  );
  return { width: width * ratio, height: height * ratio };
}

/**
 * The largest scale: four times the fitted size, and at least twice the
 * image's own pixels so a large screenshot can be read up close.
 */
export function maxScale(natural: Size, fitted: Size): number {
  return Math.max(4, (natural.width / Math.max(1, fitted.width)) * 2);
}

/**
 * Keeps the image in view. Along an axis where the image is smaller than the
 * viewport it stays centered; where it is larger, its edges cannot move past
 * the viewport edges.
 */
export function clampView(view: ZoomView, fitted: Size, viewport: Size, max: number): ZoomView {
  const scale = Math.min(max, Math.max(MIN_SCALE, view.scale));
  const limitX = Math.max(0, (fitted.width * scale - viewport.width) / 2);
  const limitY = Math.max(0, (fitted.height * scale - viewport.height) / 2);
  // `+ 0` turns -0 into 0.
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)) + 0,
    y: Math.min(limitY, Math.max(-limitY, view.y)) + 0,
  };
}

/**
 * Zooms to `scale` and keeps the image point under `focus` in place. `focus`
 * is measured from the viewport center, so the center zooms in place.
 */
export function zoomAt(view: ZoomView, scale: number, focus: Point): ZoomView {
  const ratio = scale / view.scale;
  return {
    scale,
    x: focus.x - (focus.x - view.x) * ratio,
    y: focus.y - (focus.y - view.y) * ratio,
  };
}

/** The scale change for one wheel event. A trackpad pinch arrives with `ctrlKey`. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  // Line and page deltas are rare, and much coarser than pixels.
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-100, Math.min(100, pixels));
  return Math.exp(-clamped * (pinch ? 0.01 : 0.002));
}

/** The CSS transform of a view. */
export function viewTransform(view: ZoomView): string {
  return `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
}

/**
 * The transform that lays the fitted image over `rect`, the image on the
 * page, so the viewer can grow out of it and shrink back into it.
 */
export function transformFromRect(
  rect: { left: number; top: number; width: number; height: number },
  fitted: Size,
  viewport: Size,
): string {
  const x = rect.left + rect.width / 2 - viewport.width / 2;
  const y = rect.top + rect.height / 2 - viewport.height / 2;
  return viewTransform({ scale: rect.width / Math.max(1, fitted.width), x, y });
}
