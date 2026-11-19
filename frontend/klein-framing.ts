import { uploadAsset } from "./api.js";
import { bindCropDrag } from "./crop-drag.js";
import { positionedCrop, type CropGeometry } from "./crop.js";
import { assetUrl, cropPosition, validateAsset, type Asset, type CropPosition } from "./domain.js";

const slots = ["reference_1", "reference_2", "reference_3", "reference_4"] as const;
type Slot = typeof slots[number];
type Framing = Partial<Record<Slot, { asset?: Asset; crop?: CropPosition }>>;
type Dimensions = { width: number; height: number };
type LinkedSource = { url?: string; name?: string };
type Options = {
  getDimensions(): Dimensions | null;
  getLinkedSource(slot: Slot): LinkedSource | null;
  onChange(framing: string): void;
};
const centeredCrop = { x: 0.5, y: 0.5 };

function sameCrop(first: CropPosition, second: CropPosition) {
  return first.x === second.x && first.y === second.y && (first.scale ?? 1) === (second.scale ?? 1);
}

function readFraming(value: string): Framing {
  const raw = JSON.parse(value) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Reference framing must be an object.");
  const framing: Framing = {};
  for (const [slot, entry] of Object.entries(raw)) {
    if (!slots.includes(slot as Slot) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid reference framing slot.");
    }
    const row = entry as Record<string, unknown>;
    framing[slot as Slot] = {
      ...(Object.hasOwn(row, "asset") ? { asset: validateAsset(row.asset) } : {}),
      ...(Object.hasOwn(row, "crop") ? { crop: cropPosition(row.crop) } : {}),
    };
  }
  return framing;
}

export function mountKleinFraming(container: HTMLElement, options: Options) {
  container.innerHTML = `
    <section class="happylatent klein-framing" aria-label="Reference images" data-testid="klein-framing">
      <div class="keyframe-strip" aria-label="Reference slots">
        ${slots.map((slot, index) => `<button type="button" class="keyframe-card" data-slot="${slot}" aria-pressed="false"><img alt="" hidden>Reference ${index + 1}</button>`).join("")}
      </div>
      <div class="preview-stage klein-preview" data-testid="klein-reference-preview">
        <img class="preview-image" alt="Selected reference" draggable="false" hidden>
        <div class="preview-crop-overlay" hidden><div class="preview-crop-frame" data-testid="klein-crop-frame" tabindex="0" role="group" aria-label="Reference crop. Use arrow keys to move the crop." title="Drag to move; drag a corner to resize">
          ${[["nw", "top left"], ["ne", "top right"], ["sw", "bottom left"], ["se", "bottom right"]].map(([corner, label]) => `<button type="button" class="crop-handle" data-crop-handle="${corner}" aria-label="Resize crop ${label}"></button>`).join("")}
        </div></div>
        <span class="crop-area-label" hidden>Crop</span>
        <p class="klein-preview-message"></p>
      </div>
      <div class="klein-reference-actions">
        <button type="button" class="text-button" data-action="reset">Reset crop</button>
        <div class="preview-image-actions">
          <button type="button" class="text-button" data-action="upload">Upload image</button>
          <button type="button" class="text-button" data-action="remove" hidden>Remove</button>
        </div>
      </div>
      <input type="file" accept="image/*" data-testid="klein-reference-file" hidden>
      <p class="inline-feedback" role="status" hidden></p>
    </section>`;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const stage = q(".preview-stage");
  const image = q<HTMLImageElement>(".preview-image");
  const overlay = q(".preview-crop-overlay");
  const frame = q(".preview-crop-frame");
  const label = q(".crop-area-label");
  const message = q(".klein-preview-message");
  const reset = q<HTMLButtonElement>('[data-action="reset"]');
  const upload = q<HTMLButtonElement>('[data-action="upload"]');
  const remove = q<HTMLButtonElement>('[data-action="remove"]');
  const file = q<HTMLInputElement>('[type="file"]');
  const slotButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-slot]"));
  const feedback = q(".inline-feedback");
  const events = new AbortController();
  const listen = { signal: events.signal };
  let framing: Framing = {};
  let selected: Slot = slots[0];
  let dimensions: Dimensions | null = null;
  let dimensionsKey = "";
  let linked: LinkedSource | null = null;
  let loaded = false;
  let previewFailed = false;
  let sourceUrl: string | undefined;
  let draft: CropPosition | undefined;
  let uploading = false;
  let epoch = 0;

  function tell(text = "", isError = false) {
    feedback.hidden = !text;
    feedback.textContent = text;
    feedback.setAttribute("role", isError ? "alert" : "status");
    feedback.dataset.kind = isError ? "error" : "loading";
  }

  function position() { return draft ?? framing[selected]?.crop ?? centeredCrop; }

  function geometry(): CropGeometry | null {
    if (!loaded || !dimensions) return null;
    return {
      sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight,
      outputWidth: dimensions.width, outputHeight: dimensions.height,
    };
  }

  function paintCrop() {
    const shape = geometry(), crop = position();
    const rectangle = shape && positionedCrop(
      shape.sourceWidth, shape.sourceHeight, shape.outputWidth, shape.outputHeight, crop,
    );
    const stageWidth = stage.clientWidth, stageHeight = stage.clientHeight;
    if (!shape || !rectangle || !stageWidth || !stageHeight) {
      overlay.hidden = true;
      label.hidden = true;
      return;
    }
    const scale = Math.min(stageWidth / shape.sourceWidth, stageHeight / shape.sourceHeight);
    const width = shape.sourceWidth * scale, height = shape.sourceHeight * scale;
    const left = (stageWidth - width) / 2, top = (stageHeight - height) / 2;
    Object.assign(overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    Object.assign(frame.style, {
      left: `${rectangle.x * scale}px`, top: `${rectangle.y * scale}px`,
      width: `${rectangle.width * scale}px`, height: `${rectangle.height * scale}px`,
    });
    frame.classList.toggle("is-movable", rectangle.width < shape.sourceWidth || rectangle.height < shape.sourceHeight);
    overlay.hidden = false;
    label.hidden = false;
    label.style.left = `${Math.max(2, Math.min(stageWidth - label.offsetWidth - 2, left + (rectangle.x + rectangle.width / 2) * scale - label.offsetWidth / 2))}px`;
    label.style.top = `${Math.max(2, top + rectangle.y * scale - label.offsetHeight - 8)}px`;
  }

  const drag = bindCropDrag(frame, {
    bounds: overlay, getPosition: position, getGeometry: geometry,
    onStart() {},
    onChange(crop) { draft = crop; paintCrop(); },
    onEnd(crop) {
      draft = undefined;
      if (sameCrop(crop, position())) paintCrop();
      else setCrop(crop);
    },
    onCancel() { draft = undefined; paintCrop(); },
  });
  const observer = new ResizeObserver(() => { drag.cancel(); paintCrop(); });
  observer.observe(stage);

  function change(slot: Slot, value: Framing[Slot]) {
    if (value?.asset || value?.crop) framing[slot] = value;
    else delete framing[slot];
    options.onChange(JSON.stringify(framing));
    refresh();
  }

  function referenceWithCrop(crop: CropPosition) {
    const { crop: _previous, ...source } = framing[selected] ?? {};
    return sameCrop(crop, centeredCrop) ? (source.asset ? source : undefined) : { ...source, crop };
  }

  function setCrop(crop: CropPosition) {
    change(selected, referenceWithCrop(crop));
  }

  function renderControls() {
    reset.disabled = !framing[selected]?.crop || !geometry();
    remove.hidden = Boolean(linked || !framing[selected]?.asset);
    upload.hidden = Boolean(linked);
    upload.disabled = uploading;
    upload.textContent = framing[selected]?.asset ? "Replace image" : "Upload image";
  }

  function refresh() {
    const nextDimensions = options.getDimensions();
    const key = nextDimensions ? `${nextDimensions.width}x${nextDimensions.height}` : "";
    if (key !== dimensionsKey) {
      drag.cancel();
      dimensions = nextDimensions;
      dimensionsKey = key;
    }
    for (const [index, button] of slotButtons.entries()) {
      const slot = slots[index], native = options.getLinkedSource(slot), asset = framing[slot]?.asset;
      const url = native ? native.url : asset && assetUrl(asset);
      const thumb = button.querySelector("img")!;
      if (url && thumb.getAttribute("src") !== url) {
        thumb.src = url;
        thumb.hidden = false;
      } else if (!url) {
        thumb.removeAttribute("src");
        thumb.hidden = true;
      }
      button.setAttribute("aria-pressed", String(slot === selected));
      button.title = native ? native.name ?? "Linked image" : asset?.filename ?? "Add a reference";
      if (slot === selected) linked = native;
    }
    const asset = framing[selected]?.asset;
    const url = linked ? linked.url : asset && assetUrl(asset);
    if (url !== sourceUrl) {
      drag.cancel();
      sourceUrl = url;
      loaded = false;
      previewFailed = false;
      image.hidden = true;
      if (url) image.src = url;
      else image.removeAttribute("src");
    }
    renderMessage();
    renderControls();
    paintCrop();
  }

  function renderMessage() {
    message.hidden = loaded;
    message.textContent = previewFailed ? "Could not load the reference preview." : sourceUrl
      ? "Loading reference…"
      : linked
        ? "Linked image preview is unavailable. Use a Load Image node to frame it here."
        : "Upload an image or connect a reference input.";
  }

  function settleImage() {
    if (!sourceUrl) return;
    loaded = image.complete && image.naturalWidth > 0;
    previewFailed = !loaded;
    image.hidden = !loaded;
    renderMessage();
    renderControls();
    paintCrop();
  }
  image.addEventListener("load", settleImage, listen);
  image.addEventListener("error", settleImage, listen);

  for (const [index, button] of slotButtons.entries()) {
    button.querySelector("img")?.addEventListener("error", event => { (event.target as HTMLImageElement).hidden = true; }, listen);
    button.addEventListener("click", () => {
      drag.cancel();
      selected = slots[index];
      if (!uploading) tell();
      refresh();
    }, listen);
  }
  reset.addEventListener("click", () => setCrop(centeredCrop), listen);
  remove.addEventListener("click", () => {
    drag.cancel();
    change(selected, undefined);
    tell();
  }, listen);
  upload.addEventListener("click", () => file.click(), listen);

  async function addFile(next: File) {
    const slot = selected, version = epoch;
    if (options.getLinkedSource(slot) || uploading) return;
    uploading = true;
    renderControls();
    tell("Uploading image…");
    try {
      const result = await uploadAsset(next, "image");
      if (events.signal.aborted || epoch !== version) return;
      drag.cancel();
      change(slot, { asset: result.asset });
      tell();
    } catch (error) {
      if (!events.signal.aborted && epoch === version) tell(error instanceof Error ? error.message : String(error), true);
    } finally {
      uploading = false;
      if (!events.signal.aborted) renderControls();
    }
  }
  file.addEventListener("change", () => {
    const next = file.files?.[0];
    file.value = "";
    if (next) void addFile(next);
  }, listen);
  stage.addEventListener("dragover", event => {
    if (linked || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    stage.classList.add("drag-over");
  }, listen);
  stage.addEventListener("dragleave", () => stage.classList.remove("drag-over"), listen);
  stage.addEventListener("drop", event => {
    stage.classList.remove("drag-over");
    const next = event.dataTransfer?.files[0];
    if (!next || linked) return;
    event.preventDefault();
    void addFile(next);
  }, listen);

  refresh();
  return {
    refresh,
    restore(value: string) {
      drag.cancel();
      epoch++;
      try {
        framing = readFraming(value);
        tell();
      } catch (error) {
        framing = {};
        tell(error instanceof Error ? error.message : String(error), true);
      }
      refresh();
    },
    snapshot(value: string) {
      return draft ? JSON.stringify({ ...framing, [selected]: referenceWithCrop(draft) }) : value;
    },
    dispose() {
      events.abort();
      observer.disconnect();
      drag.dispose();
    },
  };
}
