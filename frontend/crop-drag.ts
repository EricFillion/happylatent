import type { CropPosition } from "./domain.js";
import { centerCrop, resizeCrop, type CropCorner, type CropGeometry } from "./crop.js";

type CropDragOptions = {
  /** The full photo's displayed bounds, including the area outside the crop. */
  bounds: HTMLElement;
  /** Return null while the image is unavailable or editing is disabled. */
  getPosition(): CropPosition | null;
  getGeometry(): CropGeometry | null;
  onStart(): void;
  onChange(position: CropPosition): void;
  onEnd(position: CropPosition): void;
  onCancel(): void;
};
type Gesture = {
  initial: CropPosition; position: CropPosition; travelX: number; travelY: number;
  geometry: CropGeometry; sourcePerClientX: number; sourcePerClientY: number;
  corner?: CropCorner; deltaX: number; deltaY: number;
  pointerId?: number; startX?: number; startY?: number;
  keys: Set<string>;
};
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const arrows = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** A single crop edit previews freely, then commits once or is wholly cancelled. */
export function bindCropDrag(frame: HTMLElement, options: CropDragOptions): { cancel(): void; dispose(): void } {
  const abort = new AbortController();
  const events = { signal: abort.signal };
  let gesture: Gesture | undefined;

  function cornerFrom(target: EventTarget | null): CropCorner | undefined {
    const handle = target instanceof Element ? target.closest<HTMLElement>("[data-crop-handle]") : null;
    const corner = handle?.dataset.cropHandle;
    return handle && frame.contains(handle) && ["nw", "ne", "sw", "se"].includes(corner ?? "") ? corner as CropCorner : undefined;
  }
  function begin(corner?: CropCorner): Gesture | undefined {
    const position = options.getPosition();
    const geometry = options.getGeometry();
    const photo = options.bounds.getBoundingClientRect();
    const crop = frame.getBoundingClientRect();
    if (!position || !geometry || !frame.isConnected || photo.width <= 0 || photo.height <= 0 || crop.width <= 0 || crop.height <= 0) return;
    const travelX = Math.max(0, photo.width - crop.width);
    const travelY = Math.max(0, photo.height - crop.height);
    if (!corner && travelX < 0.01 && travelY < 0.01) return;
    gesture = {
      initial: { ...position }, position: { ...position }, travelX, travelY, geometry, corner,
      sourcePerClientX: geometry.sourceWidth / photo.width, sourcePerClientY: geometry.sourceHeight / photo.height,
      deltaX: 0, deltaY: 0, keys: new Set(),
    };
    frame.classList.add("is-cropping");
    options.onStart();
    return gesture;
  }
  function finish(cancelled: boolean): void {
    const finished = gesture;
    gesture = undefined;
    frame.classList.remove("is-cropping");
    if (!finished) return;
    if (finished.pointerId !== undefined && frame.hasPointerCapture(finished.pointerId)) frame.releasePointerCapture(finished.pointerId);
    if (cancelled) options.onCancel();
    else options.onEnd({ ...finished.position });
  }
  function cancel(): void { finish(true); }
  function update(position: CropPosition): void {
    if (!gesture || (position.x === gesture.position.x && position.y === gesture.position.y && (position.scale ?? 1) === (gesture.position.scale ?? 1))) return;
    gesture.position = position;
    options.onChange({ ...position });
  }
  frame.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    cancel();
    // Blurring a setting can commit it and re-render the editor. Settle that
    // before reading geometry or opening a new crop transaction.
    const corner = cornerFrom(event.target);
    const handle = corner ? (event.target as Element).closest<HTMLElement>("[data-crop-handle]") : null;
    (handle ?? frame).focus({ preventScroll: true });
    const started = begin(corner);
    if (!started) return;
    started.pointerId = event.pointerId;
    started.startX = event.clientX; started.startY = event.clientY;
    frame.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopPropagation();
  }, events);
  function pointerMove(event: PointerEvent): void {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // Distances are measured in client pixels, so ComfyUI's canvas scale cancels.
    if (gesture.corner) {
      const position = resizeCrop(
        gesture.geometry, gesture.initial, gesture.corner,
        (event.clientX - gesture.startX!) * gesture.sourcePerClientX,
        (event.clientY - gesture.startY!) * gesture.sourcePerClientY,
      );
      if (position) update(position);
    } else {
      update({
        ...gesture.initial,
        x: gesture.travelX >= 0.01 ? clamp(gesture.initial.x + (event.clientX - gesture.startX!) / gesture.travelX) : gesture.initial.x,
        y: gesture.travelY >= 0.01 ? clamp(gesture.initial.y + (event.clientY - gesture.startY!) / gesture.travelY) : gesture.initial.y,
      });
    }
    event.preventDefault(); event.stopPropagation();
  }
  frame.addEventListener("pointermove", pointerMove, events);
  frame.addEventListener("pointerup", event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // Release can carry a final position with no intervening pointermove.
    pointerMove(event);
    event.preventDefault(); event.stopPropagation(); finish(false);
  }, events);
  frame.addEventListener("pointercancel", event => { if (gesture?.pointerId === event.pointerId) cancel(); }, events);
  frame.addEventListener("lostpointercapture", event => { if (gesture?.pointerId === event.pointerId) cancel(); }, events);
  frame.addEventListener("dragstart", event => event.preventDefault(), events);
  frame.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); }, events);
  frame.addEventListener("keydown", event => {
    if (event.key === "Escape" && gesture) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (!arrows.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    if (gesture?.pointerId !== undefined) return;
    const current = gesture ?? begin(cornerFrom(event.target));
    if (!current) return;
    current.keys.add(event.key);
    const step = event.shiftKey ? 0.1 : 0.01;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (current.corner) {
      const { sourceWidth, sourceHeight, outputWidth, outputHeight } = current.geometry;
      const base = centerCrop(sourceWidth, sourceHeight, outputWidth, outputHeight);
      if (!base) return;
      current.deltaX += dx * base.width;
      current.deltaY += dy * base.height;
      const position = resizeCrop(current.geometry, current.initial, current.corner, current.deltaX, current.deltaY);
      if (position) update(position);
    } else {
      update({
        ...current.position,
        x: current.travelX >= 0.01 ? clamp(current.position.x + dx) : current.position.x,
        y: current.travelY >= 0.01 ? clamp(current.position.y + dy) : current.position.y,
      });
    }
  }, events);
  frame.addEventListener("keyup", event => {
    if (!arrows.has(event.key) || !gesture || gesture.pointerId !== undefined) return;
    event.preventDefault(); event.stopPropagation();
    gesture.keys.delete(event.key);
    // Overlapping arrow presses are one continuous edit, including diagonals.
    if (!gesture.keys.size) finish(false);
  }, events);
  frame.addEventListener("focusout", () => { if (gesture?.pointerId === undefined) finish(false); }, events);
  frame.ownerDocument.addEventListener("keydown", event => {
    if (event.key === "Escape" && gesture) { event.preventDefault(); event.stopPropagation(); cancel(); }
  }, events);
  frame.ownerDocument.defaultView?.addEventListener("blur", cancel, events);
  frame.ownerDocument.addEventListener("visibilitychange", () => {
    if (frame.ownerDocument.hidden) cancel();
  }, events);
  return { cancel, dispose() { cancel(); abort.abort(); } };
}
