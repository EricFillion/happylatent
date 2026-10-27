/** Local layout preference: resizing panels never changes a project or its undo history. */
export function bindPanelSplit(root: HTMLElement, handle: HTMLElement): { dispose(): void } {
  const workspace = root.querySelector<HTMLElement>(".happylatent-workspace")!;
  const main = root.querySelector<HTMLElement>(".happylatent-main")!;
  const timeline = root.querySelector<HTMLElement>(".timeline-panel")!;
  const canvas = root.querySelector<HTMLCanvasElement>(".timeline-canvas")!;
  const abort = new AbortController(), events = { signal: abort.signal };
  let preferredShare: number | undefined;
  let drag: { id: number; y: number; height: number; scale: number; previous: number | undefined } | undefined;
  let room = 0, minimum = 128, maximum = 128, current = 128;
  let request = 0;
  const visible = (element: Element) => getComputedStyle(element).display !== "none";
  const outerHeight = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height / scaleY() + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  };
  const scaleY = () => root.getBoundingClientRect().height / root.offsetHeight || 1;

  function layout(): void {
    if (!root.clientHeight) return;
    const fixed = [...root.children].filter(element => element !== workspace && element !== timeline && visible(element))
      .reduce((sum, element) => sum + outerHeight(element as HTMLElement), 0);
    const children = [...main.children].filter(visible);
    const mainStyle = getComputedStyle(main);
    const imageChrome = children.filter(element => !element.classList.contains("preview-stage"))
      .reduce((sum, element) => sum + outerHeight(element as HTMLElement), 0)
      + parseFloat(mainStyle.paddingTop) + parseFloat(mainStyle.paddingBottom)
      + (parseFloat(mainStyle.rowGap) || 0) * Math.max(0, children.length - 1);
    const timelineChrome = outerHeight(timeline) - canvas.getBoundingClientRect().height / scaleY();
    room = Math.max(0, root.clientHeight - fixed - imageChrome - timelineChrome);
    // Preserve readable tracks and crop handles when feedback consumes extra space.
    // Only an unusually short editor scrolls; neither panel collapses its controls.
    minimum = 128;
    maximum = Math.max(minimum, Math.min(240, room - 96));
    const workspaceMinimum = `${imageChrome + 96}px`;
    if (workspace.style.minHeight !== workspaceMinimum) workspace.style.minHeight = workspaceMinimum;
    root.classList.toggle("has-constrained-layout", room < minimum + 96);
    const desired = preferredShare === undefined ? 160 : room * preferredShare;
    current = Math.round(Math.max(minimum, Math.min(maximum, desired)));
    if (canvas.style.height !== `${current}px`) canvas.style.height = `${current}px`;
    handle.setAttribute("aria-valuemin", String(Math.round(minimum)));
    handle.setAttribute("aria-valuemax", String(Math.round(maximum)));
    handle.setAttribute("aria-valuenow", String(current));
    handle.setAttribute("aria-valuetext", `Timeline height ${current} pixels`);
  }
  function resize(height: number): void {
    preferredShare = Math.max(minimum, Math.min(maximum, height)) / Math.max(1, room);
    layout();
  }
  function finish(cancel = false): void {
    const active = drag;
    if (!active) return;
    drag = undefined;
    handle.classList.remove("is-resizing");
    if (handle.hasPointerCapture(active.id)) handle.releasePointerCapture(active.id);
    if (cancel) { preferredShare = active.previous; layout(); }
  }
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); event.stopPropagation();
    layout();
    drag = { id: event.pointerId, y: event.clientY, height: current, scale: scaleY(), previous: preferredShare };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-resizing");
  }, events);
  handle.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); event.stopPropagation();
    resize(drag.height + (drag.y - event.clientY) / drag.scale);
  }, events);
  handle.addEventListener("pointerup", event => {
    if (!drag || event.pointerId !== drag.id) return;
    resize(drag.height + (drag.y - event.clientY) / drag.scale);
    finish();
  }, events);
  handle.addEventListener("pointercancel", event => { if (event.pointerId === drag?.id) finish(true); }, events);
  handle.addEventListener("lostpointercapture", event => { if (event.pointerId === drag?.id) finish(true); }, events);
  handle.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    layout();
    if (event.key === "Enter") { preferredShare = undefined; layout(); }
    else resize(event.key === "Home" ? minimum : event.key === "End" ? maximum : current + (event.key === "ArrowUp" ? 24 : -24));
  }, events);
  handle.addEventListener("dblclick", event => { event.preventDefault(); preferredShare = undefined; layout(); }, events);
  const observer = new ResizeObserver(() => {
    if (!request) request = requestAnimationFrame(() => { request = 0; layout(); });
  });
  for (const element of [root, ...root.children, ...main.children, ...timeline.children]) observer.observe(element);
  layout();
  return { dispose() { finish(); abort.abort(); observer.disconnect(); cancelAnimationFrame(request); } };
}
