import { DEFAULT_CONTAINER_DISK_GB, DEFAULT_VOLUME_GB, TEMPORARY_CONTAINER_DISK_GB, WORKSPACE_MOUNT_PATH } from './cloud-storage.mjs';
import { RUNPOD_LAUNCH_WARNING } from './runpod-notices.mjs';

// Pinned deployment artifacts; hashes are the repositories' LFS SHA-256 values.
export const COMFY_REVISION = 'e3bee7ffcb7d6547ed0bcd15221792f3b8646b17';
export const HF_SECRET_NAME = 'happy_latent_hf';
const ltxModel = ([path, size, sha256]) => ({
  repo: 'Lightricks/LTX-2.5', revision: '49b093a39c19169a8a81721dcc541e07e945232f', path, filename: path, size, sha256,
});
const video = [
  ['diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 21504034224, 'c4279eeff115cbeaca494bd2183e7d768c38fe85a184dc6afbb7159157c44334'],
  ['text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 15372969374, '6ce688a0aa98a5fa36a9f1e6c3f42152a498cc2b53ee8c15674c64244f91487f'],
  ['vae/ltx-2.5-video-vae-conv-bf16.safetensors', 1452269922, '685b06ee3d9b2039647698fc4ea33175112462fc374e2777312c907897dfce8d'],
  ['vae/ltx-2.5-audio-vae-bf16.safetensors', 364866540, 'c52733d37f6a7fb7949c3dc0fb468c6cb2169e4d836983a73babb9f0d54837a5'],
].map(ltxModel);
const spatialUpscaler = ltxModel([
  'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
  995778752, 'eb5a71fe4068ee87ccdb1c3aa635e547ca76bd2d30ae20ae889f2c325c0677e8',
]);
const image = [
  ['diffusion_models/flux-2-klein-4b.safetensors', 7751105712, 'ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343'],
  ['text_encoders/qwen_3_4b.safetensors', 8044982048, '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a'],
  ['vae/flux2-vae.safetensors', 336211292, '868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3'],
].map(([path, size, sha256]) => ({ repo: 'Comfy-Org/Flux-2-Klein-4B', revision: '5b3abca5c0dc1ecd4eaf3340868d09063fc1c965', path, filename: `split_files/${path}`, size, sha256 }));

// Native ComfyUI XL Turbo workflow components. Sizes and hashes are the Hub's
// raw Git LFS pointers, not rounded model-card download sizes. The pinned Comfy
// revision above includes ACE15 and the variable XL architecture detection.
export const MUSIC_DOWNLOAD_FILES = Object.fromEntries([
  ['model', 'diffusion_models/acestep_v1.5_xl_turbo_bf16.safetensors', 9974719892, '86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71'],
  ['text_encoder', 'text_encoders/qwen_0.6b_ace15.safetensors', 1191588248, 'fd4590c82153b8ddb67e15a2e7aaa8afa8b83a858c8a9b82a4831063156aa7a7'],
  ['planner', 'text_encoders/qwen_4b_ace15.safetensors', 8379154232, 'ffe5ffb855086c2ab55e467e9859fb01894781020a0376484dd19de166b79873'],
  ['vae', 'vae/ace_1.5_vae.safetensors', 337431732, '6de92e3a862acd287e08b024ac90f0783a8635451b728721a33ff03565bcb2bb'],
].map(([key, path, size, sha256]) => [key, {
  repo: 'Comfy-Org/ACE-Step-1.5', revision: '8386d87da92b0a8fbba27d7132e883b8da94dda0',
  path, filename: `split_files/${path}`, size, sha256,
}]));

export function cloudModels(media, { spatialUpscale = false } = {}) {
  if (typeof spatialUpscale !== 'boolean' || (spatialUpscale && !['video', 'both', 'all'].includes(media))) {
    throw new Error('Spatial upscaling requires a cloud media selection that includes video.');
  }
  const videoModels = spatialUpscale ? [...video, spatialUpscaler] : video;
  const selections = { video: videoModels, image, both: [...videoModels, ...image], music: Object.values(MUSIC_DOWNLOAD_FILES),
    all: [...videoModels, ...image, ...Object.values(MUSIC_DOWNLOAD_FILES)] };
  if (!Object.hasOwn(selections, media)) throw new Error('Cloud media must be video, image, both, music, or all.');
  return structuredClone(selections[media]);
}

export function cloudRequirements({ media = 'both', spatialUpscale = false } = {}) {
  const models = cloudModels(media, { spatialUpscale });
  return {
    provider: 'runpod', product: 'secure GPU Pod', media, ...(spatialUpscale ? { spatialUpscale } : {}),
    comfyRevision: COMFY_REVISION, models,
    prerequisites: ['macOS or Linux with Node.js 22+ and /usr/bin/ssh', 'User-created dedicated SSH identity with mode 0600, manually registered in Runpod; use cloud_ssh_check with the locally unlocked SSH agent before spending', 'An official Runpod PyTorch template and its exact runpod/pytorch image from the live catalog, resolved to an immutable runpod/pytorch@sha256 digest', 'Authenticated Runpod exec and SCP with a pinned host key for installing the prepared bootstrap bundle', 'A signed-in Runpod MCP connection with Pod create, read, exec and stop access', 'Accept selected model terms and create the Runpod secret happy_latent_hf containing a separate dedicated fine-grained Hugging Face token granting read access only to required models; the agent checks its name automatically before planning', 'cloud_plan returns a local browser approval link showing Hugging Face repository links, each filename and decimal GB, total GB, Pod destination and runtime; the signed exact-plan approval is required before worker downloads. Setup/authentication/spending approval is not download approval'],
    sshSetup: { mode: 'manual', tool: 'cloud_ssh_check', defaultAuthentication: 'agent',
      userSteps: ['Create or select a dedicated passphrase-protected SSH key in your own terminal.', 'Unlock that key in the local SSH agent; on macOS use ssh-add --apple-use-keychain.', 'Add only its public key to Runpod Account Settings → SSH Public Keys.'],
      agentSteps: 'Check and remember the selected identity with cloud_ssh_check, match its public key against Runpod account metadata, then handle provisioning, verified bundle transfer and connection. Never generate/register/unlock the user key or request its private contents or passphrase.',
      forwarding: false, guide: 'README.md#runpod-integration-advanced' },
    authentication: {
      secretName: HF_SECRET_NAME, environmentVariable: 'HF_TOKEN',
      preflight: 'The coordinating agent must list Runpod secret metadata and match this exact name before cloud_plan or creating a Pod. If missing, direct the user to Runpod Console Secrets and stop before spending. Never request or read the secret value.',
      verification: 'Runpod MCP checks secret metadata. Verify gated repository access separately.',
    },
    templateVerification: 'The caller must verify templateId and image against the official live catalog. Local validation checks the runpod/pytorch namespace and immutable digest format, not catalog provenance. No Docker build or registry account is required.',
    hardware: {
      suggestedVramGb: ['image', 'music'].includes(media) ? 24 : 48,
      suggestedRamGb: ['image', 'music'].includes(media) ? 48 : 96,
      qualification: 'Starting points, not measured guarantees. Validate the intended resolution, duration, and GPU with a real render.',
      gpuCount: 1, architecture: 'linux/amd64', cuda: 'Match the selected official PyTorch template image to live Runpod capacity.',
    },
    storage: { modelBytes: models.reduce((sum, model) => sum + model.size, 0), suggestedVolumeGb: DEFAULT_VOLUME_GB, mountPath: WORKSPACE_MOUNT_PATH, containerDiskGb: DEFAULT_CONTAINER_DISK_GB, type: 'persistent Pod volume disk',
      temporary: { storageMode: 'container', containerDiskGb: TEMPORARY_CONTAINER_DISK_GB,
        note: 'Recommend this option by default for one-off renders. Check capacity for the requested models, setup and render files. Quote compute plus the container disk, then pass storageMode "container" to cloud_plan. Retrieve completed outputs as they become available. Stopping or restarting erases models and cloud files.' },
      reuse: 'Use cloud_plan.networkVolumeId to attach an existing user-selected Runpod Network Volume at /workspace in the same data center. Verified weights are reused across Pods while each session keeps separate media and runtime state.',
      monitoring: { tool: 'cloud_storage_status', warningUsedPercent: 80, criticalUsedPercent: 90, criticalFreeGb: 10, minimumWriteFreeGb: 2, automaticResize: false },
      note: 'Recommend temporary storage for one-off renders. Use compatible persistent storage when the user wants to resume after a stop or reuse models across sessions. For a new persistent Pod workspace, quote the 100 GB volume disk and separate 40 GB container disk with compute. Reuse existing capacity; never shrink or replace existing storage to match the default. Check the entire workspace during cloud calls and job polling. Growth is a recommendation, not spending authorization.' },
    network: { publicPorts: ['22/tcp'], comfyBind: '127.0.0.1:8188', connection: 'Full SSH with public IP; basic ssh.runpod.io proxy is unsupported.' },
    licenses: media === 'music' ? ['ACE-Step upstream MIT license and Comfy-Org repack Apache-2.0 model metadata; review the selected repository terms', 'GPL-3.0 Happy Latent/ComfyUI software'] : media === 'image' ? ['Apache-2.0 model components', 'GPL-3.0 Happy Latent/ComfyUI software'] : ['LTX-2.5 model terms and any gated repository access must be accepted by the user', 'Apache-2.0 Klein components when selected', ...(media === 'all' ? ['ACE-Step upstream MIT license and Comfy-Org repack Apache-2.0 model metadata; review the selected repository terms'] : []), 'GPL-3.0 Happy Latent/ComfyUI software'],
    workflow: ['Read the official PyTorch template and exact image from the live Runpod catalog; cloud_prepare writes a curated upload bundle.', 'Read current GPU capacity and full running hourly price with Runpod MCP.', 'Open the cloud_plan review link in a local browser to review the rate, budget, session lifetime and model files. After approval, repeat the exact tool call to get the signed plan. Show the launch warning before creation. Create one Pod only when provisionable is true and before provisionBy. Use the planned disk and mounts and verify them through Runpod MCP. Keep the stock entrypoint, disable Jupyter, and expose only TCP 22.', 'Read the template SSH host key through authenticated Runpod exec. Upload the complete prepared bundle, run its bootstrap command, and use Runpod MCP to verify and stop the exact Pod if setup fails before connection. Record the failure with cloud_setup_failed.', 'After bootstrap is ready, connect_cloud using the verified public host key. Use the normal image/video tools. Retrieve and present results, then follow cloud_shutdown_preference (default ask). Keep running without repeated questions when requested; stop only with current or remembered authorization after retrieving all requested results and checking no active work remains. Verify shutdown through Runpod MCP. Preserve the budget/deadline watchdog.'],
    launchWarning: RUNPOD_LAUNCH_WARNING,
    spending: 'The in-Pod watchdog enforces the approved deadline once it starts. Budget estimates depend on the quote. Confirm shutdown through Runpod MCP.',
  };
}
