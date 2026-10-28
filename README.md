<h1 align="center">
  HappyLatent
</h1>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="License: GPL-3.0" height="20">
  </a>
</p>


TODO ADD IMAGE

A visual editor for generating videos with LTX 2.5 in ComfyUI.

- Arrange scenes and adjust their duration on a timeline.
- Guide each scene with a prompt and optional first and last frame images.
- Choose generated audio, uploaded audio, or silence for each clip.


## Install

Run this from your ComfyUI directory to place the repo under the `custom_nodes` directory.

```sh
git clone https://github.com/EricFillion/happylatent.git custom_nodes/happylatent
```

Restart ComfyUI, then add the HappyLatent node to your workflow. Generation requires the LTX 2.5 model, text encoder, video VAE, and audio VAE, which can be retrieved by running [examples/models.py](examples/models.py).

You can find an example workflow in [examples/happylatent.json](examples/happylatent.json).



## Examples

### Multiple Scenes

TODO

### Image-to-Video

TODO 

### First and Last Frames

TODO 


