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

## Happy Latent MCP
- Create and edit multi-scene videos with your AI coding assistant. 
- Generate images and use them as scene references.
- Turn text into dialogue or narration.
- Generate and analyze music, then add it to your video.
- Regenerate individual scenes and keep your favorite takes.
- Generate video, images, and music locally or on RunPod.

## Happy Latent Video
- Edit multi-scene videos directly in a ComfyUI node.
- Arrange scenes and adjust their duration on a timeline.
- Guide each scene with a prompt and optional first and last frame images.
- Choose generated audio, uploaded audio, or silence for each clip.
- Upscale video resolution, increase frame rate, and refine the output.

## Install

Supported platforms: macOS and Linux. Windows compatibility is unverified.


### MCP

```text
Set up Happy Latent MCP from https://github.com/EricFillion/happylatent. Ask me whether I want to run it locally or on Runpod, and what I’d like to generate: video, images, speech, or music. Then guide me through setup.
```

When model downloads need approval, Happy Latent returns a local browser link. Review the files, sizes and destination, approve the plan, then tell the agent to continue. For Runpod, the review also shows the session budget.


### Happy Latent Video

Navigate to your `custom_nodes` directory then clone the repository.

```sh
git clone https://github.com/EricFillion/happylatent.git
```


## Supported Models

| Model | Task |
| --- | --- |
| [LTX 2.5](https://huggingface.co/Lightricks/LTX-2.5) | Video generation |
| [FLUX.2 Klein 4B Distilled](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B) | Image generation |
| [Kokoro 82M v1.0](https://huggingface.co/hexgrad/Kokoro-82M) | Text-to-speech |
| [ACE-Step 1.5 XL Turbo](https://huggingface.co/Comfy-Org/ACE-Step-1.5) | Music generation |



## Runpod Integration (Advanced)

1. Copy this prompt into your agent:

   ```text
   Set up Runpod for Happy Latent using https://agents.runpod.io/.
   ```

2. Create a [Hugging Face read token](https://huggingface.co/settings/tokens) and save it in [Runpod Secrets](https://console.runpod.io/user/credentials?tab=secrets) as `happy_latent_hf`.

3. Create an SSH key and [add the public key to Runpod](https://console.runpod.io/user/credentials?tab=ssh-key).

4. Copy this prompt into your agent:

   ```text
   Launch a GPU on Runpod with Happy Latent and generate a photo of a moose.
   ```

   Then keep using Happy Latent as usual.

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

## Happy Latent MCP Examples

Copy one of these prompts into your MCP-connected chat.

### Image

> Use Happy Latent to create a landscape photograph of an open violin case on a backstage bench, lit by a warm dressing-room lamp. Frame it at eye level with the violin in sharp focus. 960 × 544.

<p align="center">
  <img src="https://github.com/user-attachments/assets/a6da5ca9-ec32-4195-82a2-3c0f48e13f0e" width="640" alt="An open violin case on a backstage bench lit by a warm dressing-room lamp">
</p>


### Video

> Use Happy Latent to make a five-second landscape video of a professional male violinist stepping from backstage into a concert hall. 960 × 544.  No upscaling.


https://github.com/user-attachments/assets/b7cc3b74-ae4b-4697-b6ca-23603580aad2


### Speech

> Use Happy Latent to generate warm, unhurried male narration. Read this line exactly: “From backstage, I could hear the audience settling into their seats.”

[voice.wav](https://github.com/user-attachments/files/35189368/voice.wav)


### Music

> Use happy latent to generate the following music.  A 15-second close-miked recording of one acoustic violinist playing a quiet, unaccompanied melody. Warm tone on the G and D strings, long legato bow strokes, gentle vibrato, and small pauses that let the phrase breathe. One note at a time, with natural bow changes and subtle room ambience. End on a single sustained note with a soft bow release.

[music.wav](https://github.com/user-attachments/files/35189372/music.wav)


### Combine image, video, speech, and music

> Use Happy Latent’s image, video, speech, and music models to make a three-minute, multi-scene film at 960 × 544. No upscaling. Follow a professional male violinist from his backstage preparations through his entrance and the opening phrase of his solo. Choose the scene count, pacing, and shot sequence to suit the story. Use the image model to create a backstage reference of him in black concert attire with his violin, then use that reference with the video model to keep his appearance, wardrobe, and instrument consistent throughout the film. Use the speech model to generate “I’ve played this opening for years” and “I still take one last breath” in the same natural male voice, then use those recordings to drive lip sync in the video model. For each line, frame him alone in a steady, eye-level medium close-up with his face well lit and his mouth clearly visible. Use the music model to generate a quiet instrumental score and a separate unaccompanied violin phrase for the ending. Keep the score low under the dialogue, fade it as he raises his bow, and time the first violin note to his first bow stroke.

