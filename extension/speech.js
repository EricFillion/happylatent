import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "HappyLatent.Speech",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "HappyLatentSpeech") guardSpeechPreview(nodeType.prototype);
  },
  nodeCreated(node) {
    if (node.comfyClass !== "HappyLatentSpeech" && node.type !== "HappyLatentSpeech") return;
    guardSpeechPreview(node);
  },
});

function guardSpeechPreview(node) {
    // ComfyUI's generic background handler looks up image previews by numeric
    // node ID. An image job finishing in another workflow can share this ID.
    // Kokoro returns AUDIO only; playback belongs to the connected audio output
    // node. Do not run the generic image-preview handler on this node.
    node.onDrawBackground = function () {
      // A tab restored from older frontend state may already have this widget.
      const index = this.widgets?.findIndex(widget => widget.name === "$$canvas-image-preview") ?? -1;
      if (index >= 0) {
        this.widgets[index].onRemove?.();
        this.widgets.splice(index, 1);
      }
    };
    // Also reject late image-load callbacks and restored legacy image state.
    Object.defineProperty(node, "imgs", {
      configurable: true,
      get() { return undefined; },
      set(_images) {},
    });
}
