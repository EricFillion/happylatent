<h1 align="center">Happy Latent</h1>

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
        alt="Happy Latent visual editor in ComfyUI"
      >
    </td>
  </tr>
</table>


Happy Latent is a creative media generation MCP server with a ComfyUI video node.

### Happy Latent MCP
- Create and edit multi-scene videos with your AI coding assistant. 
- Generate images and use them as scene references.
- Turn text into dialogue or narration.
- Generate and analyze music, then add it to your video.
- Regenerate individual scenes and keep your favorite takes.
- Generate video, images, and music locally or on RunPod.

Happy Latent Video
- Edit multi-scene videos directly in a ComfyUI node.
- Arrange scenes and adjust their duration on a timeline.
- Guide each scene with a prompt and optional first and last frame images.
- Choose generated audio, uploaded audio, or silence for each clip.
- Upscale video resolution, increase frame rate, and refine the output.

## Install

### MCP

Paste this into a chat with your AI coding assistant, like Claude Code or Codex: 

```text
Set up Happy Latent MCP from https://github.com/EricFillion/happylatent. Ask me whether I want to run it locally or on Runpod, and what I’d like to generate: video, images, speech, or music. Then guide me through setup.
```

When model downloads need approval, Happy Latent returns a local browser link. Review the files, sizes and destination, approve the plan, then tell the agent to continue. For Runpod, the review also shows the session budget.

### Local speech setup

Use a separate Python environment with Kokoro and its pronunciation dependencies. Download `config.json`, `kokoro-v1_0.pth`, and at least one `voices/*.pt` preset from [Kokoro 82M](https://huggingface.co/hexgrad/Kokoro-82M), keeping the same folder layout. Then point Happy Latent at the environment and model directory.

```sh
./install.sh speech-setup --speech-python /path/to/venv/bin/python --speech-model-dir /path/to/Kokoro-82M
```

### Happy Latent Video

Navigate to your `custom_nodes` directory then clone the repository.

```sh
git clone https://github.com/EricFillion/happylatent.git
```

Download the following files from the [LTX 2.5 repository](https://huggingface.co/Lightricks/LTX-2.5) into the matching folders under `ComfyUI/models/`.

- `diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`
- `text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`
- `vae/ltx-2.5-video-vae-conv-bf16.safetensors`
- `vae/ltx-2.5-audio-vae-bf16.safetensors`

Restart ComfyUI and open the [included workflow](workflows/mcp/happylatent.json).


## Supported Models

| Model | Task |
| --- | --- |
| [LTX 2.5](https://huggingface.co/Lightricks/LTX-2.5) | Video generation |
| [FLUX.2 Klein 4B Distilled](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B) | Image generation |
| [Kokoro 82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M) | Text-to-speech |
| [ACE-Step 1.5 XL Turbo](https://huggingface.co/Comfy-Org/ACE-Step-1.5) | Music generation |



## Runpod Integration (Advanced)

1. Tell your agent, “Set up Runpod for Happy Latent using https://agents.runpod.io/.”
2. Create a [Hugging Face read token](https://huggingface.co/settings/tokens) and save it in [Runpod Secrets](https://console.runpod.io/user/credentials?tab=secrets) as `happy_latent_hf`.
3. Create an SSH key and [add the public key to Runpod](https://console.runpod.io/user/credentials?tab=ssh-key).
4. Tell your agent, “Launch a GPU on Runpod with Happy Latent and generate a photo of a moose.” Then keep using Happy Latent as usual.

Don't forget to shut down your Pods and delete persistent storage containers!

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

