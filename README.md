<h1 align="center">HappyLatent</h1>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL%203.0-b84a5b" alt="License: GPL-3.0" height="20">
  </a>
</p>

<table width="100%">
  <tr>
    <td align="center">
      <img
        src="https://github.com/user-attachments/assets/f638820e-747c-4a80-8c0d-b9521c14797e"
        width="100%"
        alt="HappyLatent visual editor in ComfyUI"
      >
    </td>
  </tr>
</table>


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

### Image-to-Video

<table width="100%">
  <tr>
    <th width="45%">Generated Video</th>
    <th width="55%">Node</th>
  </tr>
  <tr>
    <td width="45%" valign="top">
      <video src="https://github.com/user-attachments/assets/19d1b8d9-804c-42ba-a750-45625e7febd8" width="100%" controls></video>
    </td>
    <td width="55%" valign="top">
      <a href="https://github.com/user-attachments/assets/938c0386-d3db-4fac-a207-e377ea3a8845">
        <img src="https://github.com/user-attachments/assets/938c0386-d3db-4fac-a207-e377ea3a8845" width="100%" alt="HappyLatent image-to-video setup">
      </a>
    </td>
  </tr>
</table>

### Multiple Scenes
<table width="100%">
  <tr>
    <th width="45%">Generated video</th>
    <th width="55%">Node</th>
  </tr>
  <tr>
    <td width="45%" valign="top">
      <video src="https://github.com/user-attachments/assets/1e89b81d-973b-4d67-8282-0a50ded70ac6" width="100%" controls></video>
    </td>
    <td width="55%" valign="top">
      <a href="https://github.com/user-attachments/assets/971f91a8-af37-4a11-b2cc-77b0fd69b441">
        <img src="https://github.com/user-attachments/assets/971f91a8-af37-4a11-b2cc-77b0fd69b441" width="100%" alt="HappyLatent multiple-scene setup">
      </a>
    </td>
  </tr>
</table>

### First and Last Frames

<table width="100%">
  <tr>
    <th width="45%">Generated Video</th>
    <th width="55%">Node</th>
  </tr>
  <tr>
    <td width="45%" valign="top">
      <video src="https://github.com/user-attachments/assets/e1a3cc83-6826-47fa-bbc0-6669028a93c3" width="100%" controls></video>
    </td>
    <td width="55%" valign="top">
      <a href="https://github.com/user-attachments/assets/9f6de7d8-0c13-4136-a321-564f36a033d5">
        <img src="https://github.com/user-attachments/assets/9f6de7d8-0c13-4136-a321-564f36a033d5" width="100%" alt="HappyLatent first-and-last-frame setup">
      </a>
    </td>
  </tr>
</table>

