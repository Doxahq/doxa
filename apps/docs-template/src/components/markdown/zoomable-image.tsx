import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { LuMaximize, LuX, LuZoomIn, LuZoomOut } from "react-icons/lu";

import {
  CLICK_ZOOM,
  clampView,
  FIT_VIEW,
  fitSize,
  maxScale,
  transformFromRect,
  viewTransform,
  wheelZoomFactor,
  ZOOM_STEP,
  zoomAt,
  type Point,
  type Size,
  type ZoomView,
} from "@/src/lib/image-zoom";
import { cn } from "@/src/lib/utils";

const OPEN_MS = 300;
const CLOSE_MS = 220;
const ZOOM_MS = 220;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** A pointer that moves farther than this is a drag, not a click. */
const CLICK_SLOP = 5;

/**
 * A page image that opens in a full-screen viewer on click.
 *
 * In the viewer the reader zooms with the wheel, a trackpad pinch, a touch
 * pinch, a click, the buttons, or `+`, `-` and `0`, and drags to move a
 * zoomed image. Escape, the close button, or a click anywhere off the image
 * closes it. An image inside a link keeps the link instead.
 */
export function ZoomableImage({ className, onClick, ...props }: ComponentProps<"img">) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [inLink, setInLink] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setInLink(Boolean(imageRef.current?.closest("a")));
  }, []);

  if (inLink) return <img {...props} ref={imageRef} className={className} onClick={onClick} />;

  const label = props.alt ? `Enlarge image: ${props.alt}` : "Enlarge image";
  return (
    <>
      <img
        {...props}
        ref={imageRef}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="dialog"
        className={cn("cursor-zoom-in", className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setOpen(true);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLImageElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open && imageRef.current ? (
        <ImageViewer
          thumbnail={imageRef.current}
          src={imageRef.current.currentSrc || props.src || ""}
          alt={props.alt ?? ""}
          onClosed={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function naturalSize(image: HTMLImageElement): Size {
  const rect = image.getBoundingClientRect();
  // An SVG without its own size reports 0: show it at twice its page size.
  return image.naturalWidth > 0 && image.naturalHeight > 0
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: rect.width * 2, height: rect.height * 2 };
}

/**
 * The full-screen viewer. The image grows out of its place on the page and
 * shrinks back into it on close. Zoom and pan write the transform straight
 * to the element, so dragging and pinching never wait for a React render.
 */
function ImageViewer({
  thumbnail,
  src,
  alt,
  onClosed,
}: {
  thumbnail: HTMLImageElement;
  src: string;
  alt: string;
  onClosed: () => void;
}) {
  // The dialog portal mounts its content one render after this component, so
  // the effects below wait for these nodes through state, not refs.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  frameRef.current = frame;
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [natural] = useState(() => naturalSize(thumbnail));
  const [viewport, setViewport] = useState(viewportSize);
  const fitted = fitSize(natural, viewport);
  const max = maxScale(natural, fitted);
  const viewRef = useRef<ZoomView>(FIT_VIEW);
  const [scale, setScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const closingRef = useRef(false);
  const geometryRef = useRef({ fitted, viewport, max });
  geometryRef.current = { fitted, viewport, max };

  /** Moves the image to `next`, with a short ease for discrete steps. */
  const apply = useCallback((next: ZoomView, animate: boolean) => {
    const { fitted, viewport, max } = geometryRef.current;
    const view = clampView(next, fitted, viewport, max);
    viewRef.current = view;
    const frame = frameRef.current;
    if (frame) {
      frame.style.transition =
        animate && !prefersReducedMotion() ? `transform ${ZOOM_MS}ms ${EASE}` : "none";
      frame.style.transform = viewTransform(view);
    }
    setScale(view.scale);
  }, []);

  /** A point in viewport coordinates, measured from the viewport center. */
  const fromCenter = useCallback((clientX: number, clientY: number): Point => {
    const { viewport } = geometryRef.current;
    return { x: clientX - viewport.width / 2, y: clientY - viewport.height / 2 };
  }, []);

  const zoomBy = useCallback(
    (factor: number, focus: Point = { x: 0, y: 0 }, animate = true) => {
      const view = viewRef.current;
      const { max } = geometryRef.current;
      const scale = Math.min(max, Math.max(1, view.scale * factor));
      apply(zoomAt(view, scale, focus), animate);
    },
    [apply],
  );

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const frame = frameRef.current;
    const done = () => {
      thumbnail.style.visibility = "";
      onClosed();
    };
    if (!frame || prefersReducedMotion()) return done();
    const { fitted, viewport } = geometryRef.current;
    const target = transformFromRect(thumbnail.getBoundingClientRect(), fitted, viewport);
    frame.style.transition = "none";
    const animation = frame.animate(
      [{ transform: frame.style.transform || viewTransform(FIT_VIEW) }, { transform: target }],
      { duration: CLOSE_MS, easing: EASE, fill: "forwards" },
    );
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: CLOSE_MS,
      easing: EASE,
      fill: "forwards",
    });
    animation.onfinish = done;
    animation.oncancel = done;
  }, [onClosed, thumbnail]);

  // Grow out of the page image. It is hidden meanwhile, so it seems to lift off the page.
  useLayoutEffect(() => {
    if (!frame) return;
    frame.style.transform = viewTransform(FIT_VIEW);
    if (prefersReducedMotion()) return;
    thumbnail.style.visibility = "hidden";
    const { fitted, viewport } = geometryRef.current;
    frame.animate(
      [
        { transform: transformFromRect(thumbnail.getBoundingClientRect(), fitted, viewport) },
        { transform: viewTransform(FIT_VIEW) },
      ],
      { duration: OPEN_MS, easing: EASE },
    );
    backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: OPEN_MS,
      easing: EASE,
    });
    return () => {
      thumbnail.style.visibility = "";
    };
  }, [frame, thumbnail]);

  // A new window size changes the fitted size: start again from the fitted view.
  useEffect(() => {
    const onResize = () => {
      setViewport(viewportSize());
      viewRef.current = FIT_VIEW;
      setScale(1);
      const frame = frameRef.current;
      if (frame) {
        frame.style.transition = "none";
        frame.style.transform = viewTransform(FIT_VIEW);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The wheel zooms around the pointer. It needs a non-passive listener to
  // keep the browser from zooming or scrolling the page.
  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (closingRef.current) return;
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey);
      zoomBy(factor, fromCenter(event.clientX, event.clientY), false);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [fromCenter, stage, zoomBy]);

  // Pointers: one drags a zoomed image, two pinch. A press that does not
  // move is a click: on the image it zooms, anywhere else it closes.
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    moved: boolean;
    onImage: boolean;
    view: ZoomView;
    pinch: { distance: number; mid: Point } | null;
  } | null>(null);

  function pinchState() {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return null;
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || closingRef.current) return;
    if ((event.target as HTMLElement).closest("[data-viewer-control]")) return;
    try {
      // Keeps a drag going when the pointer leaves the window.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured.
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const onImage = Boolean((event.target as HTMLElement).closest("[data-viewer-image]"));
    gesture.current = {
      start: { x: event.clientX, y: event.clientY },
      moved: pointers.current.size > 1,
      onImage: gesture.current?.onImage || onImage,
      view: viewRef.current,
      pinch: pointers.current.size > 1 ? pinchState() : null,
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (current.pinch) {
      const now = pinchState();
      if (!now) return;
      const scale = current.view.scale * (now.distance / current.pinch.distance);
      const focus = fromCenter(current.pinch.mid.x, current.pinch.mid.y);
      const zoomed = zoomAt(current.view, Math.min(max, Math.max(1, scale)), focus);
      apply(
        {
          ...zoomed,
          x: zoomed.x + now.mid.x - current.pinch.mid.x,
          y: zoomed.y + now.mid.y - current.pinch.mid.y,
        },
        false,
      );
      return;
    }

    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    current.moved = true;
    if (current.view.scale > 1) {
      setDragging(true);
      apply({ ...current.view, x: current.view.x + dx, y: current.view.y + dy }, false);
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    pointers.current.delete(event.pointerId);
    if (!current) return;
    if (pointers.current.size > 0) {
      // One finger of a pinch lifted: the other one goes on as a drag.
      const [rest] = [...pointers.current.values()];
      gesture.current = { ...current, start: rest ?? current.start, view: viewRef.current, pinch: null };
      return;
    }
    gesture.current = null;
    setDragging(false);
    if (current.moved || event.type === "pointercancel") return;
    if (!current.onImage) return close();
    if (viewRef.current.scale > 1.01) apply(FIT_VIEW, true);
    else zoomBy(CLICK_ZOOM, fromCenter(event.clientX, event.clientY));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
    else if (event.key === "0") apply(FIT_VIEW, true);
    else return;
    event.preventDefault();
  }

  const zoomed = scale > 1.01;
  const percent = Math.round(((fitted.width * scale) / Math.max(1, natural.width)) * 100);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-[100] outline-none"
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            thumbnail.focus({ preventScroll: true });
          }}
        >
          <DialogPrimitive.Title className="sr-only">{alt || "Image"}</DialogPrimitive.Title>
          <div ref={backdropRef} className="absolute inset-0 backdrop-blur-sm bg-black/85" />
          <div
            ref={setStage}
            className={cn(
              "overflow-hidden absolute inset-0 select-none touch-none",
              dragging ? "cursor-grabbing" : "cursor-zoom-out",
            )}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div
              ref={setFrame}
              className="absolute will-change-transform"
              style={{
                left: (viewport.width - fitted.width) / 2,
                top: (viewport.height - fitted.height) / 2,
                width: fitted.width,
                height: fitted.height,
              }}
            >
              <img
                data-viewer-image=""
                src={src}
                alt={alt}
                draggable={false}
                className={cn(
                  "block object-contain w-full h-full rounded-md shadow-2xl",
                  dragging ? "cursor-grabbing" : zoomed ? "cursor-grab" : "cursor-zoom-in",
                )}
              />
            </div>
          </div>

          <div
            data-viewer-control=""
            className="flex absolute top-3 right-3 gap-1 items-center p-1 text-white rounded-full ring-1 shadow-lg backdrop-blur bg-black/60 ring-white/10"
          >
            <ViewerButton label="Zoom out" disabled={!zoomed} onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <LuZoomOut />
            </ViewerButton>
            <span className="text-xs tabular-nums text-center min-w-12 text-white/80" aria-live="polite">
              {percent}%
            </span>
            <ViewerButton label="Zoom in" disabled={scale >= max - 0.01} onClick={() => zoomBy(ZOOM_STEP)}>
              <LuZoomIn />
            </ViewerButton>
            <ViewerButton label="Fit to screen" disabled={!zoomed} onClick={() => apply(FIT_VIEW, true)}>
              <LuMaximize />
            </ViewerButton>
            <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
            <ViewerButton ref={closeRef} label="Close" onClick={close}>
              <LuX />
            </ViewerButton>
          </div>

          {alt ? (
            <p
              data-viewer-control=""
              className={cn(
                `pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit max-w-[min(42rem,90vw)] 
                rounded-full bg-black/60 px-4 py-1.5 text-center text-sm text-white/90 transition-opacity duration-200`,
                zoomed && "opacity-0",
              )}
            >
              {alt}
            </p>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ViewerButton({
  label,
  disabled,
  onClick,
  children,
  ref,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid place-items-center text-base rounded-full transition-colors size-8 text-white/90 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}
