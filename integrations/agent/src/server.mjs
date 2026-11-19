import { UploadPreference } from './upload-preference.mjs';
import { assetContent } from './asset-preview.mjs';
import { voiceGuide } from "./voices.mjs";
import { resultContent } from "./result-content.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import metadata from "../package.json" with { type: "json" };
import { Inspection, inspectionContent } from "./inspection.mjs";
import { Cloud, cloudRequirements } from "./cloud.mjs";
import { LAUNCH_STAGES, WORKER_STAGES } from "./cloud-launch.mjs";
import { referenceCrop } from "./images.mjs";
import { Projects, validateForGeneration } from "./projects.mjs";
import { Speech, isSpeechJob } from "./speech.mjs";
import { Library } from "./library.mjs";
import { ApprovalGate, mcpApprovalRequest } from "./approvals.mjs";
import { approveCloudDownload } from "./cloud-approval.mjs";
import { ModelDownloads } from "./downloads.mjs";
import { ModelReviewPending, ModelReviews } from "./model-review.mjs";
import { musicRequestFields } from "./music.mjs";
import { musicPlacementRequest, planMusicPlacement } from "./music-placement.mjs";
import { Memory, memoryFields, memorySelector } from "./memory.mjs";
import { projectWithMemory, sceneContext, resolveCharacterSpeech } from "./scene-memory.mjs";

const id = z.string().trim().min(1).max(128);
const cloudMedia = z.enum(["video", "image", "both", "music", "all"]);
const cloudLimits = {
  quotedHourlyUsd: z.number().positive(), maxHourlyUsd: z.number().positive(),
  maxTotalUsd: z.number().positive(), maxMinutes: z.number().int().min(2).max(1440),
};
const runpodPreflightEvidence = z.strictObject({
  checkedAt: z.iso.datetime(), signedIn: z.boolean(),
  registeredPublicKeys: z.array(z.string().max(8192)).max(100).optional(),
  secretNames: z.array(id).max(200).optional(),
  template: z.strictObject({ id, image: z.string().max(500), python312: z.boolean(), ssh: z.boolean(), git: z.boolean() }).optional(),
  gpu: z.strictObject({ id, dataCenterId: id, available: z.boolean(), secureCloud: z.boolean(), cudaCompatible: z.boolean() }).optional(),
  volume: z.strictObject({ id, dataCenterId: id, idle: z.boolean(), monthlyStorageUsd: z.number().nonnegative() }).optional(),
  runningPrice: z.strictObject({ computeUsd: z.number().positive(), storageUsd: z.number().nonnegative() }).optional(),
});
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const frame = z.number().int().nonnegative();
const dimensions = z.number().int().min(64).max(4096).multipleOf(32);
const unit = z.number().min(0).max(1);
const enhancements = z.strictObject({
  spatialUpscale: z.boolean().optional().describe("Double output width and height with the installed LTX spatial upscaler. Enable with refinement for default portrait (576x1024 base, 1080x1920 delivery) and landscape (1024x576 base, 1920x1080 delivery) video recipes; resize locally after AI upscaling."),
  temporalUpscale: z.boolean().optional().describe("Double output frame rate while preserving duration, using the installed LTX temporal upscaler."),
  refine: z.boolean().optional().describe("Refine with the existing video model. Always enabled when either upscaler is enabled."),
}).optional().describe("Render settings saved with the job. For new portrait or landscape video requests, explicitly pass spatialUpscale=true, refine=true and temporalUpscale=false with a 576x1024 portrait or 1024x576 landscape base, unless the user specifies otherwise. Omitting this object leaves API enhancements off; model downloads are never automatic.");
const asset = z.strictObject({
  filename: z.string().min(1).max(255),
  subfolder: z.string().max(255).optional(),
  type: z.literal("input").optional(),
}).describe("The asset field returned by import_asset, import_generated_image, or import_generated_speech.");
const openingImage = asset.describe("The opening-frame asset from import_asset or import_generated_image. Use a still composed for this shot.");
const imageReference = asset.extend({
  crop: referenceCrop.optional().describe("Frame the reference to the output aspect ratio. x/y are fractions of crop travel and scale is the fraction of the centered crop to keep."),
});
const video = z.strictObject({
  id, asset: asset.extend({ type: z.enum(['input', 'output']) }),
  frameCount: z.number().int().positive().max(72000), fps: z.number().min(1).max(120),
  width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), hasAudio: z.boolean(),
  name: z.string().max(120).optional(), createdAt: z.string().max(64).optional(), projectId: id.optional(), sceneId: id.optional(),
  sourceStartFrame: frame.optional(),
}).describe('An existing video take returned by import_asset(kind=video), list_clips or get_clip. Choosing it is an edit only; its embedded audio is reused.');
const renderOptions = {
  mode: z.enum(['generate', 'selected', 'export']).optional().describe('generate reuses chosen takes and generates missing scenes; selected makes new takes only for sceneIds; export assembles chosen takes without models.'),
  sceneIds: z.array(id).min(1).max(100).optional().describe('Generate fresh takes only for these scenes, keeping original scene indices and all other chosen takes. Implies selected mode.'),
};
const sceneSampling = {
  cfg: z.number().min(0).max(30).optional(),
  sampler: z.enum(["euler_ancestral", "euler", "dpmpp_2m"]).optional(),
  scheduler: z.enum(["distilled", "custom"]).optional(),
  imageStrength: unit.optional().describe("Opening-frame conditioning strength. For reference-based on-camera speech, start at 0.6 with audioGuidanceScale 1, then review lip sync and identity on a short and full-length take. This is a practical starting point, not a guarantee; honor explicit user settings."),
};
const projectSettings = {
  title: z.string().max(200).optional(),
  globalPrompt: z.string().max(16000).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  width: dimensions.optional().describe("Base generation width, before enhancements. Default portrait (vertical, 9:16) to 576 with height 1024; landscape (horizontal, 16:9) to 1024 with height 576. Apply LTX spatial upscale plus refinement, then resize to 1080x1920 portrait or 1920x1080 landscape. Honor explicit user dimensions."),
  height: dimensions.optional().describe("Base generation height, before enhancements. Default portrait to 1024 with width 576; landscape to 576 with width 1024. LTX spatial upscaling produces 1152x2048 portrait or 2048x1152 landscape before local 1080p delivery. Honor explicit user dimensions."),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  samplingPreset: z.enum(["auto", "distilled", "full"]).optional(),
  sampling: z.strictObject({ ...sceneSampling, steps: z.number().int().min(2).max(100).optional() }).optional(),
};
const prompt = z.string().max(48000);
const durationFrames = z.number().int().positive().max(1200).describe("Exact output frames. A scene can last up to 20 seconds. With supplied audio, default to its measured duration rounded up to a whole video frame, avoiding added silence.");
const sceneSettings = {
  name: z.string().max(120).optional(),
  video: video.optional(),
  image: openingImage.optional(),
  crop: referenceCrop.optional(),
  endImage: asset.optional(),
  endCrop: referenceCrop.optional(),
  imageStrength: unit.optional().describe("Opening-frame conditioning strength. For reference-based on-camera speech, start at 0.6 with audioGuidanceScale 1, then review lip sync and identity on a short and full-length take. This is a practical starting point, not a guarantee; honor explicit user settings."),
  endImageStrength: unit.optional(),
  audioGuidance: z.boolean().optional(),
  audioGuidanceScale: z.number().min(1).max(5).optional().describe("Supplied-audio guidance strength for this scene. Default 1 preserves normal conditioning. Values above 1 may improve synchronization with the supplied speech, but add a model pass per sampling step and may introduce artifacts. Active only with supplied audio and audioGuidance enabled. Does not change the recorded soundtrack."),
  sampling: z.strictObject(sceneSampling).optional(),
};
const scene = z.strictObject({
  ...sceneSettings, prompt, durationFrames,
  audioMode: z.enum(["generated", "silent"]).optional(),
});
const beforeSceneId = id.optional().describe("Insert before this scene. Omit to place at the end.");
const sceneId = id.describe("A stable scene ID from get_project.");
const operation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("update_project"), patch: z.strictObject(projectSettings) }),
  z.strictObject({ op: z.literal("add_scene"), scene, beforeSceneId }),
  z.strictObject({ op: z.literal("update_scene"), sceneId, patch: z.strictObject({
    ...sceneSettings, prompt: prompt.optional(), durationFrames: durationFrames.optional(),
      image: openingImage.nullable().optional(), crop: referenceCrop.nullable().optional(),
      endImage: asset.nullable().optional(), endCrop: referenceCrop.nullable().optional(),
      video: video.nullable().optional(),
  }) }),
  z.strictObject({ op: z.literal('add_clip'), clipId: id, beforeSceneId, name: z.string().max(120).optional(), sourceStartFrame: frame.optional(), durationFrames: durationFrames.optional() }),
  z.strictObject({ op: z.literal('choose_take'), sceneId, clipId: id, sourceStartFrame: frame.optional() }),
  z.strictObject({ op: z.literal('detach_take'), sceneId }),
  z.strictObject({ op: z.literal("move_scene"), sceneId, beforeSceneId }),
  z.strictObject({ op: z.literal("remove_scene"), sceneId }),
  z.strictObject({ op: z.literal("set_scene_audio"), sceneId, mode: z.enum(["generated", "silent", "supplied"]) }),
  z.strictObject({
    op: z.literal("place_audio"), asset, startFrame: frame, endFrame: frame.nullable(),
    sourceOffsetSamples: frame.max(600 * 48000).optional(),
    audioId: id.optional().describe("ID of the supplied block to replace. Omit to create a new block."),
    name: z.string().max(255).optional(),
  }),
  z.strictObject({ op: z.literal("remove_audio"), audioId: id }),
  z.strictObject({ op: z.literal('place_music'), asset, startFrame: frame, endFrame: frame,
    sourceStartSeconds: z.number().min(0).max(600).optional(),
    audioDurationSeconds: z.number().positive().max(600).optional().describe('Measured automatically from the selected asset before saving.'),
    gainDb: z.number().min(-60).max(6).optional(), fadeInSeconds: z.number().min(0).max(30).optional(),
    fadeOutSeconds: z.number().min(0).max(30).optional(), musicId: id.optional(), name: z.string().max(255).optional() }),
  z.strictObject({ op: z.literal('remove_music'), musicId: id }),
]);

export async function startMcp(config, { transport, downloadServices } = {}) {
  const { stateDir, comfyUrl, workspaceDir, speech: speechConfig } = config;
  const projects = new Projects(stateDir);
  const memory = new Memory({ stateDir, workspaceDir });
  const library = new Library({ stateDir });
  const approvalContext = new AsyncLocalStorage();
  let approvalRequest;
  const approvals = new ApprovalGate(request => approvalRequest(request));
  const modelReviews = new ModelReviews();
  const modelApprovals = new ApprovalGate(requestModelApproval);
  const uploadPreference = new UploadPreference(stateDir, request => approvalRequest(request));
  const cloud = new Cloud(config, {
    confirmAction: async ({ kind, manifest, message, timeoutMs }) => {
      if (kind === 'cloud_transfer') return uploadPreference.confirm(manifest, message, approvalContext.getStore()?.signal);
      await approvals.require({ kind, ...manifest }, message, { signal: approvalContext.getStore()?.signal, reuse: false, timeoutMs }); return true;
    },
    approveDownloads: input => approveCloudDownload(stateDir, modelApprovals, { ...input, signal: approvalContext.getStore()?.signal }),
  });
  const shutdownPreference = cloud.shutdownPreference;
  const downloads = new ModelDownloads(config, modelApprovals, downloadServices);
  // Each operation captures its runtime under the cloud manager's lock.
  const comfy = new Proxy({}, { get: (_target, method) => (...args) => cloud.withComfy(client => client[method](...args)) });
  const speech = new Speech({ stateDir, speech: speechConfig });
  const inspection = new Inspection({ stateDir, resolveJob: async jobId => {
    if (isSpeechJob(jobId)) return { result: await speech.getResult(jobId) };
    return cloud.withComfy(async client => {
      const job = await client.readJob(jobId);
      const result = await client.getResult(jobId);
      const project = job.projectId && !(job.operation && job.sourceClipId)
        ? (await projects.get(job.projectId, job.revision)).project : undefined;
      return { result, project };
    });
  } });
  const server = new McpServer({ name: "happy-latent", title: "Happy Latent", version: metadata.version }, {
    instructions: [
      "Happy Latent generates multi-scene videos, Klein 4B images and ACE-Step 1.5 XL Turbo music via local or Runpod ComfyUI. For new setup without an explicit runtime choice, first ask where to generate, offering Local — on this computer first, then Runpod — paid cloud GPU. Local uses the user's hardware and disk space; Runpod requires an account and spending authorization. Wait for the choice before backend installation, model downloads, provisioning, or check_setup, which can start managed local ComfyUI. If unsure, offer read-only hardware/storage checks. Reuse an explicit prior choice or established runtime; do not ask on every render or silently switch from a disconnected cloud target. A default loopback URL or config file alone is not a local choice. Guide required human actions one at a time, keeping credentials out of chat. Once the chosen runtime is configured and connected, start with check_setup for the requested media.",
      "For music use ACE-Step 1.5 XL Turbo only; never substitute a smaller checkpoint. check_setup media=music checks its four native ComfyUI components. generate_music supports 10–600 seconds per track, instrumental music or supplied lyrics, BPM, key, meter and seed. Poll get_job and show get_result's playable excerpt plus full audio path. Analyze the actual recording using analyze_music(jobId or imported asset), then import_generated_music to obtain an input asset for the timeline. analyze_music returns measured energy, estimated beats/tempo, structural change candidates and confidence; it does not listen, detect vocals, transcribe lyrics or establish mood, a chorus, a drop or artistic quality. Generation prompts/BPM are intentions, not measured evidence. Use the storyboard and inspect_video/get_video_frames to reason about where music fits. plan_music produces a reviewable source-window and timeline plan, using profile=start, low_energy, high_energy or build. place_music saves that plan as a new project revision with scope=full_video, scenes or frame ranges. Music is a separate final-mix layer: it preserves scene dialogue/effects and is not LTX conditioning. Use gainDb and fades, and choose a quieter cue under speech; automatic vocal-aware ducking is not implemented. Full-video scoring spans adjacent scenes continuously. A too-short source is rejected, never silently looped or padded; use multiple explicit cues for longer videos. Edits do not render. Choose existing takes and call export_video to mix music without generating footage; generate_video also includes the layer in its assembled result, never in individual immutable takes. edit_project place_music/remove_music supports exact adjustments. Do not add music to unrequested parts. Existing budget, storage and transfer rules apply to music. Local download_models media=music uses exact-file approval; new cloud_prepare media=music selects only music, media=all includes video/image/music. An existing deployment needs its music files installed explicitly; generation never installs them.",
      "An installed managed local backend starts on demand and is shared between chats. Cold startup can take up to two minutes; retry check_setup after a client timeout. Use diagnose_setup for read-only installation diagnostics. Generation and readiness tools never install dependencies or download models. Only the explicit download_models tool starts local video or music model downloads with automatic downloads below 1 GB and exact-plan approval for larger batches. The managed backend stops after its last client disconnects and queued work completes unless explicitly kept running with the start command.",
      "For local Hugging Face authentication, follow https://huggingface.co/docs/hub/agents-cli and the official CLI installation guide. Install the official hf CLI if missing; its standalone installer supports Windows, macOS and Linux and includes the CLI skill. With other installation methods, hf skills add installs a project skill. Ask the user to create a dedicated fine-grained token with only required model repository read permissions, then run hf auth login in their own separate terminal and choose Paste an access token. If already logged in with OAuth or a broader token, use hf auth login --force. Decline Git credential storage if asked. Never enter tokens for them, put tokens in chat/arguments/environment, or start the OAuth/--format agent login flow. Happy Latent reads the active HF CLI token cache using HF_TOKEN_PATH, HF_HOME or the default HF cache location, with the same OS user/cache settings as the terminal; --state-dir does not select this shared cache. It validates fine-grained model-read permissions live before use and ignores ambient HF_TOKEN, OAuth and legacy Happy Latent credentials. The compatibility auth command only checks CLI credentials; auth --forget only removes legacy Happy Latent credentials. Explicit hf auth logout affects other tools sharing that cache; provider revocation is separate. Never run hf auth token or read/print credential files into tool output. Never transfer the local token into Runpod automatically.",
      "Use check_model_access to inspect missing local video or music files and Hugging Face access. Use download_models for those files and cloud_plan for cloud image, video or music weights. Codex prompts in chat and continues the tool call after approval. Claude and other MCP clients use browser review. Let the user respond to the prompt. When either tool returns awaiting_approval, show approvalUrl as a clickable link and end the turn. Ask the user to open it in their browser on the computer running Happy Latent, approve the exact files and destination, then tell you to continue. The user may copy the URL into their browser if the client cannot open it. Retry with identical arguments after they approve and keep the MCP session open during review. Never open or submit the review on the user’s behalf or treat chat text as approval. Changed sources, revisions, files, destinations or runtimes require a fresh review. If a new-session review expires, get a fresh quote before retrying cloud_plan. For an in-place review, retry only while the existing lease is active. Local image, speech and optional-upscaler installation remain manual and require review of their exact source and file lists. Ordinary generation never downloads models.",
      "The default Runpod volume is 100 GB. For a temporary container-disk-only session, use cloud_requirements.storage.temporary and set cloud_plan storageMode to container. The separate container disk is not part of that 100 GB. Cloud tools and get_job refresh total /workspace storage, including models, caches, environments, all takes and unrelated files. Show the storage recommendation when usage first reaches warning (80% used) or critical (90% used or below 10 GB free), and again only when severity/target size changes or the user asks. Use cloud_storage_status before a large batch, optionally passing estimated additional requiredFreeGb and labeling it an estimate. Reports are only live while the runtime is connected and calls are being made; disconnected, stale or unsupported telemetry is unavailable, never evidence of free space. New generation and uploads are refused below a 2 GB free reserve; reads and result retrieval remain allowed. Recommend the reported larger capacity, verify the existing volume and live resize price with Runpod, then get spending approval before resizing. Prefer increasing the existing network volume to replacing it; verify the new filesystem capacity afterwards. Never resize, migrate, delete storage or remove models/takes automatically. Confirmed retrieved-media cleanup is an alternative. Persistent storage charges continue after GPU shutdown.",
      "Reuse the selected Runpod Pod for follow-up generations. When check_setup reports missing models, use cloud_install_models with its existing planId and poll cloud_model_install_status. This requests approval for the exact missing files and keeps the original budget and deadline. If awaiting_approval is returned, use the same browser review and retry procedure as cloud_plan. Check readiness again when installation completes. If in-place installation is unavailable, explain the blocker and ask before provisioning another Pod. For a new session use cloud_requirements, cloud_prepare and cloud_plan with live capacity/prices and spending authorization. Show the launch warning and provision only while provisionable is true and before provisionBy. Reconcile ambiguous creates using cloud_status and Runpod MCP before retrying. Never create a second Pod for the same plan.",
      "SSH key setup is manual. Guide the user through the RunPod Integration section of README.md: they create or select a dedicated key, enter its passphrase in their own terminal, and add only its public key in Runpod Account Settings. Do not generate, replace or unlock their key or modify their account's SSH-key registration for them, and never request private key contents or passphrases in chat/tool arguments. After they finish, call cloud_ssh_check with the absolute private-key path (not contents), normally authentication: agent. This verifies the selected key with the LOCAL SSH agent and remembers the path; it does not forward the agent or verify Runpod registration. Read Runpod account public-key metadata and match the returned public key before spending. Use that public key in cloud_plan. Existing file-mode keys remain supported; never strip a passphrase to make automation work. Subsequent provisioning, verified bundle transfer and connection are agent-managed. Pass the same selected identity and local-agent settings when using SCP; keep ForwardAgent=no and strict host-key checks.",
      "Choose an official Runpod PyTorch template from the live catalog and resolve its image to an immutable runpod/pytorch@sha256 digest; mutable tags are rejected. Python packages come from bundled hashed locks. cloud_prepare writes an upload bundle; no image build or registry is required. Create the Pod using the exact deployment image, environment, disk and mounts with only TCP 22 and Jupyter disabled. Use deployment.templateId when supplied. Container storage plans omit it to avoid inheriting a volume, and require a read-back with empty mounts and the planned disk size. When the user selects an existing Network Volume for model reuse, look it up through Runpod MCP, verify Secure Cloud stock and pricing in its data center, and pass its ID as networkVolumeId. Verify the planned storage in Runpod before uploading the bundle. Use one active Happy Latent Pod per Network Volume. Keep the selected volume for later sessions and never silently create, resize or delete storage. Keep the template entrypoint. Read its public SSH host key through authenticated Runpod exec, upload the bundle over verified SSH, and run the returned bootstrap command through authenticated Runpod exec before connect_cloud. On any unrecoverable setup failure before connection, record it with cloud_setup_failed and immediately use Runpod MCP to verify ownership and current state of the exact task-owned Pod, request stop if available, and read it again until Runpod confirms EXITED or TERMINATED. If the local failure write fails, still reconcile the Pod through Runpod MCP. If the runtime already connected, use the normal cloud_stop checks. If verification fails, give the user the Pod name or ID and the Runpod Pods link.",
      "Before planning a new deployment, automatically list Runpod secret metadata through Runpod MCP and check for the exact secret name happy_latent_hf. If absent, direct the user to create that secret in Runpod Console with a separate dedicated fine-grained Hugging Face token granting read access only to required models, and stop before spending. Resolve a failed metadata lookup before proceeding. Do not ask the user to supply a secret name, token, or tool argument. New plans use this fixed secret reference automatically; saved plans retain their original secretRequirement. Check that saved name, if present, before any provisioning retry. Existence does not verify token validity or gated model access. Never read or print token values. Do not send account API keys or private SSH keys to the Pod. The non-root renderer and package installers do not inherit HF_TOKEN. The renderer cannot read root-owned credential/supervisor files; root/template processes remain trusted.",
      "For new Runpod sessions call cloud_preflight before cloud_plan. Gather its required provider observations through the signed-in Runpod MCP client, and only offer a remembered volume after checking its live price and availability. Use the exact prepared template, verified SSH key and live quote from the preflight. Finish all read-only checks before spending.",
      "Before create call cloud_track_launch with allocating. Only the caller receiving launchClaimed=true may create, and only once. Keep the deployment payload returned by cloud_plan for that create. Save allocated with the exact provider read-back and GPU type, and report each later checkpoint. Poll cloud_status(planId) during setup, including while waiting for SSH. A stop_required response means record cloud_setup_failed and reconcile, stop, verify and record the exact Pod through Runpod MCP. While bootstrapping, use authenticated Runpod exec with the plan's setup.statusCommand. Show meaningful stage changes and the elapsed time. If the client was interrupted, recover the recorded stage through cloud_status instead of creating again.",
      "For video batches with a tight lease, use cloud_video_estimate after retrieving a one-shot representative render under the full intended recipe. Treat missing measurements as unknown. If the estimate is over budget, show timing and estimated cost and ask which constraint to change before full rendering. Preserve AI spatial upscaling, refinement, delivery resolution and the approved lease.",
      "The in-Pod watchdog enforces the session deadline once bootstrap starts it. Verify shutdown with Runpod MCP. The budget is an estimated running-session limit. Retrieve results before shutdown. Stopping erases temporary container storage. For persistent volumes, remind the user to terminate the Pod or delete a separate volume once its storage is no longer needed. Obtain approval for model terms and any gated access before deployment. On the first cloud media upload or prompt submission, the client asks once whether to allow all requested Runpod transfers or ask each time. The choice is remembered across chats and restarts on this installation. allow_all covers media and prompts needed for user requests to current and future connected Runpod Pods; ask_each_time asks once per transfer, with Allow this transfer — keep asking and Allow all — don’t ask again on every reminder. Choosing allow_all there approves the current transfer and remembers standing consent immediately. Read cloud_upload_preference or use configure_cloud_uploads to change it through the client dialog. Do not add a duplicate chat permission question. A current request to ask again means call configure_cloud_uploads before transferring. This preference never authorizes spending, model downloads or cleanup. Use cloud_data_inventory to review saved cloud media and cloud_cleanup for a separately confirmed cleanup after retrieving outputs; this leaves shared models and runtime logs. After retrieving all requested cloud results, read cloud_shutdown_preference. Default ask: present results and ask whether to stop the Pod, explaining that compute billing continues; offer Keep running, Stop now, and a remembered preference. keep_running: leave it running without repeating the shutdown question. stop_after_results: treat the saved explicit preference as shutdown authorization; stop only after all requested results are retrieved and no queued or running work remains, then verify provider state. A current explicit user instruction overrides the saved preference for this task. Change the saved mode only when the user explicitly asks to remember it; a one-time answer does not change it. All modes retain the approved budget/deadline watchdog and failure-recovery shutdown, and never extend a lease silently. Fetch outputs before cloud_stop. The tool checks the queue and local results and requests client confirmation unless stop_after_results is saved. Let the client dialog handle confirmation. Verify stopped state with Runpod MCP. A stop request is not verified shutdown and disconnect is not cleanup. disconnect_cloud closes only the tunnel. Speech generation remains local.",
      "Translate the user's creative intent into observable outcomes before generation. Describe the intended action, timing, presentation and sound clearly where relevant, using concrete behavior rather than relying only on broad style adjectives. Preserve explicit requirements and use established context to resolve routine choices.",
      "Scope each constraint to the subject, action or property it is meant to control. Check that restrictions on one aspect do not suppress another required behavior. Prefer a clear positive description of the intended result; avoid blanket restrictions or exclusive wording that accidentally limits the whole performance.",
      "Review the prompt, reference assets, audio, duration and generation settings together before submission. Resolve contradictions across these inputs and confirm that they support the same intended outcome. Do not assume that a prompt can reliably override an incompatible reference or setting.",
      "Separate technical completion from creative success. A completed job or valid media file does not establish that the result matches the brief. Review the relevant appearance, behavior, timing and sound using available inspection and playback capabilities. State what was actually measured or observed and what remains unverified; stills and metadata cannot establish continuous motion or audiovisual synchronization.",
      "Before applying an unproven approach across a batch, review a representative output at the intended duration and settings, especially for the behavior most likely to fail. Reuse suitable existing results when available. Resolve demonstrated mismatches before scaling that approach; do not treat uncertain inspection as a reason for automatic regeneration. Keep review and any authorized revisions within the user's budget and scope, without adding routine approval gates.",
      "When revising a result, identify the specific mismatch and make the smallest relevant change. Hold other inputs, settings and the seed constant where supported so comparisons are useful. Preserve previous takes and compare against the original intent and user feedback. Report observed improvements separately from hypotheses about their cause; one successful revision does not establish a universal recipe.",
      "Present completed outputs as they become available, including playable previews for audio and video when supported, with concise captions explaining their purpose and revision. Do not wait for an entire batch to finish before showing accessible completed results. Honor the user's requested progress frequency; previews are informational, not additional approval gates.",
      "Keep reusable guidance general purpose. Store project-specific characters, subjects, story details and individual take histories with the project. Promote only transferable lessons to shared instructions, express uncertain findings as conditional guidance, and let explicit user requirements override defaults.",
      "Default to Happy Latent's Klein image generator for new images and missing video opening frames. Skip the provider question and use local ComfyUI when local is configured. If the user chose Runpod, use that runtime. Follow the runtime choice procedure for new setup. For Klein, call check_setup with media=image before generate_image.",
      "Use OpenAI image generation only when the user explicitly requests it. Use the client's OpenAI image-generation tool and its image skill, preview the result, and import an accessible image from the configured workspace with import_asset (kind=image). If the requested provider or an importable result is unavailable, report the blocker and get the user's agreement before switching providers.",
      "For multi-scene videos that need a consistent character, object, or setting, use shot-specific opening frames. Reuse suitable supplied frames via import_asset. Pass the same imported subject or setting image in generate_image references when composing other shots with Klein. Keep the shared features and describe the setting, framing, and poses for each shot.",
      "Generate one image per job. Use the user's width and height in pixels or dimensions already set for the destination clip. Ask for pixel dimensions if neither is known.",
      "Wait for each Happy Latent node image job to complete, then use import_generated_image and set its returned asset as the matching scene's image. Set the frames before validate_project and generate_video.",
      "If image setup is incomplete, report what's missing. Use available references or text for any shots without frames when the brief allows it. Model downloads require explicit user approval.",
      "For scripted dialogue, narration, or characters who need a consistent voice, check_setup with media=speech to see the installed Kokoro voice IDs. Use generate_speech with the same speaker ID and speed for each recurring character. Generate each spoken line separately from action and sound descriptions.",
      "Wait for speech jobs to complete. Use import_generated_speech and place the returned asset in the project with edit_project place_audio. Set timing from the returned duration, keep each block within its intended scene, and enable audioGuidance for on-camera dialogue. Use supplied audio without guidance for narration. Supplied audio replaces generated audio in that scene, and quiet gaps will be silent. Keep ambience or silent scenes in their requested audio modes.",
      "When providing audio, measure or import it before finalizing clip durations. By default, make the video clip as long as the audio used in it: durationFrames = ceil(sampleCount * fps / sampleRate), or ceil(duration * fps) when only duration is available. Place the audio at the clip start and end the clip at the recording's end, allowing only the sub-frame rounding needed to avoid cutting off speech. Do not pad a short recording to a convenient longer clip length or add unrequested silent lead-in, tail, or gaps between lines. When one recording spans several shots, match their combined duration to the recording. Preserve explicitly requested pauses, action beats, or fixed durations; allocate remaining runtime outside the supplied-audio clips when appropriate. Matching duration avoids added silence, but does not remove silence already in the recording.",
      "For lip-synced on-camera dialogue, prefer one clearly visible speaking face at a time. Compose both the reference image and video prompt as a stable, eye-level medium close-up or head-and-shoulders shot, with a clear front or gentle three-quarter view of the face. For generated dialogue, keep head movement minimal throughout the shot: allow natural blinking and subtle expressions, but avoid large nods, tilts, turns, or rapid head motion. The starting/reference frame must show the full speaking face, including the forehead, eyes, mouth, and chin, unobstructed and inside the frame. Start with the head settled in a front or gentle three-quarter pose; do not begin mid-turn, mid-tilt, or with the head moving into position, as in the earlier Nia take. Apply this requirement to both the opening-frame composition and the video prompt. Keep the face well lit and the mouth unobstructed, large enough to read, and visible throughout the spoken line; avoid profile or rear views of the speaker, extreme angles, and turns away while speaking. Keep the listener off camera or show only the back of their head and shoulder, with their mouth out of view. Use separate reaction shots or natural speaker changes. Identify the visible speaker and exact words in the prompt and state that only this person speaks. Apply this composition when generating or revising dialogue opening frames, rather than relying only on a prompt telling other visible people to stay silent. Honor explicitly requested group shots or camera angles; this is a preferred composition, not a guarantee of lip sync.",
      "For a two-person conversation, a useful editing approach is:\n\n- **Alternate close-ups:** show each person while they deliver their line.\n- **Use over-the-shoulder shots:** keep the listener’s mouth out of view.\n- **Use wider shots between lines:** establish both people together without requiring dialogue synchronization.",
      "Keep scene.audioGuidanceScale at its default 1 unless stronger supplied-audio conditioning is needed. Values above 1, up to 5, may help synchronize visible speech with the supplied dialogue. Compare a short speaking clip before applying a higher value broadly. Higher values add a model evaluation per base sampling step, may introduce artifacts, and do not guarantee lip-sync. This is active only for clips with provided audio and audioGuidance enabled; it does not alter the source recording. Validate before rendering to detect an outdated backend.",
      "For reference-image on-camera speech, start with scene.imageStrength=0.6 and audioGuidanceScale=1 unless the user chooses otherwise. This is an empirical starting point, not a guarantee or a change to non-speaking scenes. Review representative full-length speech audiovisually before a batch; contact-sheet stills do not establish lip sync. Preserve identity, compare one setting at a time, and distinguish generation resolution from export resolution. Honor a native-resolution requirement unless the user agrees to upscaling, and never label enlarged output native 1080p. Honor explicit user settings and assess each new character, recording and scene.",
      "After a video completes, use inspect_video for a contact sheet and measurements; inspect selected timestamps with get_video_frames and compare revisions with compare_renders. inspect_audio measures levels and silence. These tools return PNG images and JSON, requiring local ffmpeg/ffprobe. Distinguish measurements from visual observations; never claim listening, continuous-motion or lip-sync verification from these reports. Do not regenerate solely on an uncertain finding or exceed approved spending.",
      "Keep project and job IDs for follow-up requests. Wait for a completed job before fetching its result.",
      "Use list_projects and list_jobs to find earlier work by title, prompt text, or ID without starting a runtime. Use list_project_revisions to inspect changes and get_thumbnail for a locally downloaded completed image/video. Library job states are saved observations, not a live queue read; use get_job on the matching runtime for current status.",
      "Video renders save immutable individual scene clips and an assembled video. Use list_clips/get_clip on the selected runtime to find earlier takes. import_asset accepts kind=video. edit_project add_clip or choose_take only changes the timeline and never queues generation. Existing takes retain their embedded audio; recipe audio stays saved for regeneration. detach_take restores generation from the scene recipe. Use generate_video with sceneIds to regenerate only requested scenes, preserving all other chosen takes. If unselected scenes have no chosen take, the result is explicitly a selection preview, not the full timeline. get_result returns clips with sceneIds plus the assembled MP4 and scope. Apply choose_take explicitly after reviewing results; never silently replace concurrent project edits. export_video requires a take for every scene and assembles without model inference. Old takes remain available after regeneration.",
      "For recurring characters or locations, use list_memories to find saved descriptions, voices and references across chats. set_scene_memory pins selected revisions to scenes. Prompt descriptions are applied at render/export time. Reuse a pinned voice with generate_speech, and explicitly import_memory_reference to compose a shot-specific image. Saving or assigning memory is local and does not transfer references or start jobs.",
      "Video check_setup, validate_project, generate_video and export_workflow accept enhancements: spatialUpscale doubles width/height, temporalUpscale doubles FPS, and refine adds refinement with the existing video model. Either upscaler forces refinement. Validate the exact enhancements before rendering and use a new requestId when changing them. Optional upscaler weights must already be installed. For a user-requested upscale of an already finished take, use check_setup media=upscale and upscale_video. It applies spatial 2x AI upscaling and source-guided refinement to the saved clip as a separate take; it does not select it or regenerate the scene.",
      "Default video recipes (LTX AI upscale + refinement): for new portrait (vertical, 9:16) requests, use a 576x1024 base project, producing 1152x2048 with AI upscaling, then deliver at 1080x1920. For new landscape (horizontal, 16:9) requests, use a 1024x576 base project, producing 2048x1152 with AI upscaling, then deliver at 1920x1080. Both default to fps=24 unless the user specifies otherwise. Pass enhancements={spatialUpscale:true, refine:true, temporalUpscale:false} consistently to check_setup(media=video), validate_project, generate_video and export_workflow when used. After get_result, resize the enhanced output locally to the corresponding delivery dimensions with a high-quality spatial resize such as FFmpeg Lanczos, preserving frame count, duration and audio. Delivery dimensions are not the base project dimensions. Describe these outputs as AI-upscaled 1080p, never native 1080p. Explicit dimensions, aspect ratio, frame rate, native-resolution or no-upscaling requirements override the corresponding defaults; preserve existing projects unless the user requests a change. Check the spatial-upscaler readiness and follow the existing exact model-download approval flow if its weights are missing. Do not silently substitute ordinary resizing alone for the AI upscale. This rendering preference does not authorize model downloads or additional cloud spending.",
      "User-confirmed preference (2026-11-16): keep the default landscape recipe of 1024x576 generation, LTX 2x AI spatial upscaling with refinement, and 1920x1080 delivery. A budget limit is not permission to disable spatialUpscale or refine, lower the delivery resolution, or substitute ordinary resizing. If measured timing indicates that the requested runtime and this recipe cannot fit the authorized budget, present the measured estimate and ask which constraint to change before the full render; never exceed the budget or extend the lease without authorization. Show sample generated images during production.",
      "Before choosing a speech voice, consult get_voice_guide or the voiceGuide returned by check_setup media=speech. Match language/accent and requested presentation, using installed speakers only. Style fields marked unknown are not evidence of warmth, depth, age or emotion; audition a representative line when style matters. The guide includes unsupported Japanese and Mandarin presets for completeness; never submit those through this integration.",
      "Show creative progress in chat as it happens. Fetch each finished reference image with get_result and immediately display its inline preview (or returned local image path), with a short scene/purpose caption and dimensions. Do this before moving on to the next reference or the video render. For every completed text-to-speech line, immediately fetch get_result and present playable audio (native audio content or the local WAV path), the exact spoken text, speaker and speed. Never wait until the final video to show these intermediate assets. Use concise human captions rather than dumping prompts or JSON. Before video submission, summarize resolution, fps, duration, scene count and audio choices once. Report meaningful stage changes while polling; avoid repeating unchanged updates. Honor requests for quiet progress. These are progress updates, not new approval gates.",
      "After each import_asset, import_generated_image or import_generated_speech, immediately display the returned preview with a short filename/purpose caption. Images include a resized inline image; audio includes a playable excerpt and waveform, with full duration and an explicit truncation label; videos include a start/middle/near-end contact sheet and the local sourcePath for playback. Use absolute local paths for media embeds. If preview generation fails, show the sourcePath and warning without retrying a successful upload. Previews are informational, not another approval gate.",
      "get_job includes observed scene/stage progress for video and image jobs. Sampling percentages and estimates describe only the current sampling stage, not the entire render. Treat unavailable or old observations as incomplete. Failure recommendations never authorize an automatic retry or extra spending.",
      "Reuse existing authorization for the same action and scope. Routine generation and reversible edits within the selected runtime and approved session budget do not need another confirmation. cloud_plan combines new cloud spending and model-download approval; do not add a duplicate chat approval for that same plan. Private-data transfers follow cloud_upload_preference; destructive cleanup retains its separate exact-plan confirmation. Never treat an agent-supplied approval flag as user consent.",
    ].join("\n"),
  });

  const elicit = mcpApprovalRequest(server.server);
  approvalRequest = request => elicit({ ...request, relatedRequestId: approvalContext.getStore()?.requestId });

  async function requestModelApproval(request) {
    const { modelRequestKey, startedAt, callId } = approvalContext.getStore();
    if (server.server.getClientVersion()?.name !== 'codex-mcp-client') {
      return modelReviews.request(modelRequestKey, request);
    }

    // Return a confirmation error before Codex's default 60-second tool timeout.
    const timeoutMs = Math.min(startedAt + 45_000, request.expiresAt ?? Infinity) - Date.now();
    if (timeoutMs <= 0) throw new Error('The Codex confirmation window expired. Request a fresh review.');

    // A nonempty form requires an explicit decision even under Full Access.
    const approvalChoice = 'Approve this plan';
    const requestedSchema = {
      type: 'object',
      properties: {
        decision: { type: 'string', title: 'Decision', enum: [approvalChoice] },
      },
      required: ['decision'],
    };
    // Codex uses its own callId to attach the form to the tool call in chat.
    const meta = { codex_requires_user_input: true, ...(callId ? { callId } : {}) };
    const response = await approvalRequest({ ...request, timeoutMs, requestedSchema, meta });
    if (response.action === 'accept' && response.content?.decision !== approvalChoice) {
      throw new Error('Codex did not return the required plan decision. Retry and choose “Approve this plan” in the confirmation form.');
    }
    return response;
  }

  function tool(name, description, inputSchema, run, annotations = {}) {
    server.registerTool(name, {
      description, inputSchema: z.strictObject(inputSchema),
      annotations: { openWorldHint: false, destructiveHint: false, ...annotations },
    }, async (input, context) => {
      try {
        const result = await approvalContext.run({
          signal: context?.signal, requestId: context?.requestId, modelRequestKey: `${name}:${input.requestId}`, startedAt: Date.now(),
          callId: typeof context?._meta?.callId === 'string' ? context._meta.callId : undefined,
        }, async () => {
          try {
            return await run(input, context);
          } catch (error) {
            if (error instanceof ModelReviewPending) return { ...error.result, requestId: input.requestId };
            throw error;
          }
        });
        if (["import_asset", "import_generated_image", "import_generated_speech", "import_generated_music", "import_memory_reference"].includes(name)) return assetContent(result, { inlineAudio: input.inlineAudio ?? input.inlineMusicAudio });
        if (name === "get_result") return resultContent(result, query => library.thumbnail(query), input);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message ?? String(error) }] };
      }
    });
  }

  function inspectionTool(name, description, schema, method) {
    server.registerTool(name, { description, inputSchema: z.strictObject(schema),
      annotations: { destructiveHint: false, openWorldHint: false } }, async input => {
      try { return await inspectionContent(await inspection[method](input)); }
      catch (error) { return { isError: true, content: [{ type: "text", text: error.message ?? String(error) }] }; }
    });
  }
  inspectionTool("inspect_video", "Inspect a completed video with media measurements and an inline PNG contact sheet. Panels are row-major; consult timestamp/scene labels in the report. Sparse frames cannot verify motion or lip-sync. Requires local ffmpeg/ffprobe.",
    { jobId: id, samples: z.number().int().min(3).max(12).optional() }, "video");
  inspectionTool("get_video_frames", "Return 1–8 inline PNG video frames at requested seconds using accurate seeks, resized to fit 768×432. Inspect specific details; no continuous-video understanding is implied.",
    { jobId: id, timestamps: z.array(z.number().finite().nonnegative()).min(1).max(8) }, "frames");
  inspectionTool("compare_renders", "Return two inline PNG sheets from completed videos at their start/middle/end, optionally aligned by stable sceneId across revisions. Relative-time comparison; does not assign a quality winner.",
    { jobIds: z.array(id).length(2), sceneId: id.optional() }, "compare");
  inspectionTool("inspect_audio", "Measure audio in a completed video or speech job. Returns an inline waveform PNG, levels and silence intervals. These are signal measurements, not listening, transcription, click detection or lip-sync assessment.",
    { jobId: id }, "audio");

  const query = { projectId: id, revision: revision.optional() };
  const jobQuery = { jobId: id };
  const inlineAudio = z.boolean().optional().describe("Include a native MCP audio block for clients that accept audio input. By default, play the local WAV from preview.audioPath or the speech result's path.");
  const musicPlaybackQuery = { ...jobQuery, inlineAudio, inlineMusicAudio: z.boolean().optional().describe(
    "Music-only compatibility option. An explicit inlineAudio takes precedence."
  ) };
  const readOnly = { readOnlyHint: true, idempotentHint: true };
  tool("get_voice_guide", "Read all Kokoro voice profiles and selection guidance. Documented language/accent and presentation only; unauditioned style is explicitly unknown. Does not start a runtime. Use check_setup media=speech for installed availability.",
    {}, () => voiceGuide(), readOnly);
  const pagination = {
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(2048).optional().describe("Opaque nextCursor returned by the previous page with the same filters."),
  };
  tool('save_memory', 'Save a reusable character or location locally across chats sharing this state directory. Creates a new entry; updates require memoryId and expectedRevision and replace descriptive fields. Omitted referencePaths preserve existing references; [] clears them. Copies PNG/JPEG/WebP images from the workspace or owned cached image results. Does not upload or generate. Existing scene assignments remain pinned until explicitly reassigned.',
    { ...memoryFields, memoryId: id.optional(), expectedRevision: revision.optional() }, input => memory.save(input));
  tool('get_memory', 'Read a character or location and its pinned reference files. Omit revision for latest; historical revisions remain available after edits or archiving. Local only.',
    { memoryId: id, revision: revision.optional() }, input => memory.get(input), readOnly);
  tool('list_memories', 'Find saved characters and locations across chats. Search names, descriptions, notes and tags. Archived entries are hidden by default. Does not start a runtime.',
    { kind: z.enum(['character', 'location']).optional(), query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
      includeArchived: z.boolean().optional() }, input => memory.list(input), readOnly);
  tool('archive_memory', 'Archive or restore a character or location using its latest expectedRevision. Keeps all historical records and reference files; pinned scenes are unchanged.',
    { memoryId: id, expectedRevision: revision, archived: z.boolean() }, input => memory.archive(input));
  tool('set_scene_memory', 'Replace character/location assignments on selected scenes and save a project revision. Resolves and pins full memory snapshots; later library edits cannot change them. Descriptions are appended to video prompts at render/export time. Voices and reference images remain available through get_scene_memory for speech and opening-frame composition; no generation or upload occurs. To clear, pass characters:[] and omit location/notes.',
    { projectId: id, expectedRevision: revision, sceneIds: z.array(id).min(1).max(100),
      characters: z.array(memorySelector).max(8), location: memorySelector.optional(), notes: z.string().max(8000).optional() },
    async ({ projectId, expectedRevision, sceneIds, characters, location, notes }) => {
      const load = async selector => {
        const latest = await memory.get({ memoryId: selector.memoryId });
        if (latest.archived) throw new Error('Restore archived memories before assigning them to a new scene.');
        return selector.revision === undefined || selector.revision === latest.revision ? latest : memory.get(selector);
      };
      const entries = await Promise.all(characters.map(load));
      const place = location ? await load(location) : undefined;
      if ([...entries, ...(place ? [place] : [])].some(entry => entry.archived)) throw new Error('Restore archived memories before assigning them to a new scene.');
      return projects.setMemory(projectId, expectedRevision, sceneIds, { characters: entries,
        ...(place ? { location: place } : {}), ...(notes !== undefined ? { notes } : {}) });
    });
  tool('get_scene_memory', 'Read the pinned character/location snapshots, saved voices/reference paths, scene notes and effective prompt for one scene. Use pinned IDs/revisions with generate_speech or import_memory_reference. Does not generate or upload.',
    { ...query, sceneId: id }, async ({ projectId, revision, sceneId }) => sceneContext(await projects.get(projectId, revision), sceneId), readOnly);
  tool('import_memory_reference', 'Upload one retained character/location reference image to the currently selected runtime. Use an explicit memory revision and zero-based index (default 0). Returns the normal asset preview; show it immediately. Cloud upload preferences apply. Use the imported asset to compose a shot-specific opening frame; importing does not edit scenes or generate.',
    { memoryId: id, revision, index: z.number().int().min(0).max(3).optional() }, input => comfy.importMemoryReference(input));
  tool("list_projects", "Search saved projects by title or text and return recent summaries, IDs, revisions and available previews. Reads local records without starting ComfyUI.",
    { query: z.string().max(500).optional(), ...pagination }, input => library.listProjects(input), readOnly);
  tool("list_jobs", "Search saved video, image, speech and music jobs across local and cloud runtimes. States are saved observations; use get_job on the matching runtime for a live check. Does not start a runtime or download results.",
    { query: z.string().max(500).optional(), media: z.enum(["video", "image", "speech", "music"]).optional(),
      status: z.enum(["submitting", "queued", "running", "completed", "failed", "cancelled", "unknown"]).optional(),
      projectId: id.optional(), runtime: z.enum(["local", "cloud"]).optional(), ...pagination },
    input => library.listJobs(input), readOnly);
  tool("list_project_revisions", "List saved revisions of a project, newest first, with timestamps and compact change summaries. Reads local records only.",
    { projectId: id, ...pagination }, input => library.listProjectRevisions(input), readOnly);
  server.registerTool("get_thumbnail", {
    description: "Return a small inline PNG preview for a completed image/video or speech waveform already saved in the local result library. Use get_result first if the result is not cached. Never starts a runtime or submits generation.",
    inputSchema: z.strictObject(jobQuery), annotations: { openWorldHint: false, destructiveHint: false },
  }, async input => {
    try { return await inspectionContent(await library.thumbnail(input)); }
    catch (error) { return { isError: true, content: [{ type: "text", text: error.message ?? String(error) }] }; }
  });

  tool("check_model_access", "Show the missing files, download destination and Hugging Face access status for local LTX video or ACE-Step music. Can start an installed managed ComfyUI. Performs checks only and does not request approval or download weights.",
    { media: z.enum(['video', 'music']).optional() }, (input, context) => downloads.preview(input, context?.signal), { openWorldHint: true, idempotentHint: true });
  tool("download_models", "Review missing local LTX video or ACE-Step 1.5 XL Turbo music models. Codex confirms in chat and continues this call. Other MCP clients receive a browser review link. If status is awaiting_approval, show approvalUrl as a link for the user to open in their local browser and end the turn. Retry with identical arguments after they approve. Downloads are resumable and verified. No approval argument is accepted. Generation never downloads weights.",
    { requestId: id, media: z.enum(['video', 'music']).optional() }, (input, context) => downloads.start(input, context?.signal), { openWorldHint: true, idempotentHint: true });
  tool("get_download", "Read the status of a model download started in this MCP session.",
    { downloadId: z.string().uuid() }, input => downloads.status(input), readOnly);
  tool("cancel_download", "Cancel an active model download, retaining verified files and resumable partial files.",
    { downloadId: z.string().uuid() }, input => downloads.cancel(input), { idempotentHint: true });
  tool("cloud_requirements", "Describe the private Runpod deployment, model artifacts, provisional hardware, storage, and spending-control limits. For the default video recipe, set spatialUpscale to include the official LTX spatial upscaler. No provisioning.",
    { media: z.enum(["video", "image", "both", "music", "all"]).optional(), spatialUpscale: z.boolean().optional() }, cloudRequirements, readOnly);
  tool("cloud_preflight", "Check Runpod launch readiness and show fixes before provisioning. Supply observations from live Runpod MCP account key/secret metadata, official template and GPU availability reads. Use only public SSH keys and secret names. Include the running compute-plus-storage quote and user limits. With no provider observations, shows missing checks and the last used Network Volume candidate, if any. Verify its live price, idle status and data-center stock before offering reuse. Does not provision, select storage or request approval.",
    { identityFile: z.string().min(1).max(4096).optional(), authentication: z.enum(["agent", "file"]).optional(),
      provider: runpodPreflightEvidence.optional(), templateId: id.optional(), image: z.string().max(500).optional(),
      networkVolumeId: id.optional(), limits: z.strictObject(cloudLimits).optional(),
      media: cloudMedia.optional(), spatialUpscale: z.boolean().optional() },
    input => cloud.preflight(input), readOnly);
  tool("cloud_track_launch", "Persist the Runpod launch stage. Before create, record allocating and require launchClaimed=true. If false or the create result is lost, reconcile the exact planned name before any retry. After create, use provider read-back for the exact Pod ID/name/image, and record its GPU type on allocated. Record ssh_verified after pinned direct SSH succeeds, then bundle_uploaded and bootstrap_started. During bootstrap submit the stage timestamps from the authenticated status command when present in the plan. Follow stop_required: record cloud_setup_failed, stop the verified exact Pod through Runpod MCP, read back EXITED or TERMINATED, then record stopped. This tool records provider observations and does not issue provider calls.",
    { planId: z.string().uuid(), stage: z.enum([...LAUNCH_STAGES, "stopped"]),
      pod: z.strictObject({ id, name: id, image: z.string().max(500), status: id, gpuId: id.optional() }).optional(),
      worker: z.strictObject({ runtimeId: z.string().uuid(), podId: id, deadline: z.iso.datetime(), status: id,
        watchdogStatus: z.string().nullable().optional(),
        stages: z.partialRecord(z.enum(WORKER_STAGES), z.iso.datetime({ offset: true })) }).optional() },
    input => cloud.trackLaunch(input), { idempotentHint: true });
  tool("cloud_video_estimate", "Estimate how many seconds and dollars a batch of matching refined LTX shots needs within a saved lease. Uses a successfully rendered and retrieved representative shot with observed base sampling and refinement on the same GPU and pinned image. Specify frame counts at 24 fps and orientation. Before allocation, supply the GPU type ID from the live quote. For a sample on an earlier lease supply samplePlanId. Returns missing measurements or warns if the batch may exceed the remaining lease. Does not submit a job or change the recipe, deadline or budget.",
    { planId: z.string().uuid(), samplePlanId: z.string().uuid().optional(), sampleJobId: z.string().uuid().optional(),
      shotFrames: z.array(z.number().int().positive().max(100000)).min(1).max(100),
      orientation: z.enum(["landscape", "portrait"]).optional(), gpuId: id.optional() },
    input => cloud.videoEstimate(input), readOnly);
  tool("cloud_ssh_check", "Check and remember a user-created SSH key before spending. The user manually creates/selects the key, unlocks it in their own terminal and adds the PUBLIC key in Runpod settings. Default agent mode checks signing with that selected key in the local SSH agent; no agent forwarding. File mode supports an existing unencrypted key. Reads no private contents into tool results, never generates/registers keys and accepts no passphrase. Agent must separately match Runpod account public-key metadata.",
    { identityFile: z.string().min(1).max(4096).describe("Absolute path to the user-selected private key, never its contents."), authentication: z.enum(["agent", "file"]).optional() },
    input => cloud.checkSsh(input), { idempotentHint: true });
  tool("cloud_prepare", "Prepare a Happy Latent upload bundle for an official Runpod PyTorch template. Supply templateId and its immutable runpod/pytorch@sha256 image digest from the live official catalog/registry. Set spatialUpscale to include the official LTX spatial upscaler in the bundle and subsequent model download review. No Docker build, registry, GPU, dependency install or model download is performed.",
    { media: z.enum(["video", "image", "both", "music", "all"]).optional(), templateId: id, image: z.string().min(1).max(500),
      spatialUpscale: z.boolean().optional() }, input => cloud.prepare(input));
  tool("cloud_plan", "Review a Runpod session and its exact model downloads. Check happy_latent_hf via Runpod MCP secret metadata and quote compute plus running storage first. Codex confirms in chat and continues this call. Other MCP clients receive a browser review link. If status is awaiting_approval, show approvalUrl for the user to open in their local browser and end the turn. Retry with identical arguments after they approve. Show launchWarning and create one Pod only when provisionable is true and before provisionBy. Use the exact returned disk and mounts. For storageMode=container, create from deployment.image without templateId and verify the returned mounts are empty. Pass networkVolumeId only for a user-selected existing Runpod Network Volume. Omit deploy-when-available queue options. Reuse requestId after a lost response and reconcile the exact Pod first.",
    { requestId: id, contextId: z.string().length(64), sshPublicKey: z.string().min(1).max(8192),
      networkVolumeId: id.optional().describe("Exact existing Runpod Network Volume ID verified through Runpod MCP in the selected data center. Omit for a Pod volume disk."),
      storageMode: z.literal("container").optional().describe("Use only a temporary 120 GB container disk. Stopping or restarting the Pod erases its models and outputs. Cannot be combined with networkVolumeId."),
      quotedAt: z.iso.datetime(), ...cloudLimits },
    input => cloud.plan(input), { idempotentHint: true });
  tool("cloud_setup_failed", "Record failed setup before Happy Latent connected and return the planned Pod identity. Immediately use Runpod MCP to read the exact task-owned Pod, verify ownership and stop it, then read its state until Runpod confirms EXITED or TERMINATED. Once connected, use cloud_stop for normal shutdown.",
    { planId: z.string().uuid() }, ({ planId }) => cloud.setupFailed(planId), { idempotentHint: true });
  tool("cloud_install_models", "Install missing pinned Hugging Face model files on the currently selected Runpod Pod after exact-file client approval. Use its existing planId from cloud_status. The original lease, Pod, and storage remain in place. Set spatialUpscale for video when using the LTX spatial upscaler. If awaiting_approval is returned, show the review link and retry with identical arguments after approval. Poll cloud_model_install_status with the returned installId. If installation fails, review the remaining files with a new requestId. Older bootstrapped runtimes do not support this operation.",
    { planId: z.string().uuid(), requestId: id, media: z.enum(["video", "image", "both", "music", "all"]), spatialUpscale: z.boolean().optional() },
    input => cloud.installModels(input), { openWorldHint: true, idempotentHint: true });
  tool("cloud_model_install_status", "Read the status of a model installation on the selected Runpod Pod. Once completed, rerun check_setup for the requested media.",
    { planId: z.string().uuid(), installId: z.string().regex(/^[a-f0-9]{64}$/) }, input => cloud.modelInstallStatus(input), readOnly);
  tool("connect_cloud", "Connect to a bootstrapped Runpod Pod using a private SSH tunnel. Reuses the user-created key selected by cloud_ssh_check; identityFile/authentication are optional overrides. Agent mode uses only that selected public identity with the LOCAL agent; forwarding stays disabled. Pin the public hostKey read through authenticated Runpod exec (ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key), never an unverified network scan. Never pass private-key contents or passphrases. On reconnect, planId alone reuses saved SSH settings.",
    { planId: z.string().uuid(), podId: id.optional(), host: z.string().min(1).max(253).optional(), port: z.number().int().min(1).max(65535).optional(), identityFile: z.string().min(1).max(4096).optional(), authentication: z.enum(["agent", "file"]).optional(), hostKey: z.string().min(1).max(8192).optional() },
    input => cloud.connect(input), { idempotentHint: true });
  tool("cloud_upload_preference", "Read the remembered Runpod media/prompt transfer preference: not_set, allow_all or ask_each_time. No transfer or preference change.",
    {}, () => uploadPreference.read(), readOnly);
  tool("configure_cloud_uploads", "Ask the user once through the client dialog whether to allow all requested Runpod media/prompt uploads or ask each time. Remembers the choice across chats and restarts on this installation. Use to change or revoke standing consent; every later upload reminder also offers Allow all to stop reminders immediately. No transfer occurs. No agent-supplied approval is accepted.",
    {}, (_input, context) => uploadPreference.configure(context?.signal));
  tool("cloud_shutdown_preference", "Read the remembered post-generation shutdown mode. Default ask. No runtime changes.",
    {}, () => shutdownPreference.read(), readOnly);
  tool("set_cloud_shutdown_preference", "Remember a post-generation shutdown choice on explicit user request. Saving stop_after_results requires client confirmation and applies after all work is finished and results are retrieved. ask requests confirmation for each stop. keep_running leaves the Pod running within its lease.",
    { mode: z.enum(["ask", "keep_running", "stop_after_results"]) }, ({ mode }) => cloud.setShutdownPreference(mode), { idempotentHint: true });
  tool("cloud_status", "Inspect the selected runtime, deadline, estimated spend, watchdog and workspace storage. Supply planId to inspect the saved setup state before connecting. Billing and final Pod state must be read from Runpod MCP.", { planId: z.string().uuid().optional() }, ({ planId }) => cloud.status(planId), readOnly);
  tool("cloud_storage_status", "Measure total, used and free space on the connected cloud workspace, including all models, caches and media. Warns at 80% used; critical at 90% used or below 10 GB free. Recommends a larger volume without resizing, deleting or spending. Optionally assess additional space for a known batch. Does not start a Pod or reconnect a tunnel.",
    { requiredFreeGb: z.number().finite().min(0).max(1000000).optional().describe("Additional space needed for a planned batch or download, in decimal GB. Omit for current usage only; this is a planning input, not a measured render-size prediction.") },
    input => cloud.storageStatus(input), readOnly);
  tool("disconnect_cloud", "Close the SSH tunnel. Does not stop the Pod or billing. By default keep the cloud target selected and block generation until reconnected; useLocal explicitly switches generation back to local ComfyUI.",
    { useLocal: z.boolean().optional() }, input => cloud.disconnect(input), { idempotentHint: true });
  tool("cloud_stop", "Request shutdown after checking the exact runtime, an empty generation queue and local copies of completed outputs. The tool requests client confirmation unless stop_after_results is saved. Honor an explicit request to keep the Pod running by leaving it alone. Verify shutdown through Runpod MCP. Stopping erases temporary container storage. Persistent volumes may remain billable.",
    {}, () => cloud.stop(), { destructiveHint: true, idempotentHint: true });

  tool("cloud_data_inventory", "List only this runtime's recorded Happy Latent cloud inputs and outputs, sizes and retrieval status. No deletion. Shared models and runtime logs are outside this scope.",
    { scope: z.enum(['inputs', 'outputs', 'all']).optional() }, input => cloud.inventoryData(input), readOnly);
  tool("cloud_cleanup", "Display and confirm an exact cleanup plan for recorded Happy Latent cloud inputs/outputs. Requires client confirmation, idle jobs and locally retrieved outputs. Retains shared models, environment and runtime logs. Does not stop the Pod or delete provider storage.",
    { scope: z.enum(['inputs', 'outputs', 'all']).optional() }, (input, context) => cloud.cleanupData(input, { signal: context.signal }), { destructiveHint: true });
  tool("diagnose_setup", "Check local dependencies, backend readiness, and installation next steps without starting ComfyUI, downloading models, or generating media.",
    {}, async () => { const { doctor } = await import('./verify.mjs'); return doctor(config); }, readOnly);
  tool("check_setup", "Check video, image, music, standalone upscale or local speech setup. Starts an already provisioned managed local ComfyUI when needed; never installs software or downloads models.",
    { media: z.enum(["video", "image", "speech", "music", "upscale"]).optional().describe("Defaults to video. upscale checks LTX 2.5 spatial upscaling for existing takes."), enhancements },
    async ({ media, enhancements }) => {
      if (enhancements && media && media !== "video") throw new Error("Enhancements apply to video only.");
      const setup = await (media === "speech" ? speech.checkSetup() : cloud.withComfy(async client => {
        const result = await client.checkSetup({ media, enhancements });
        if (result.status !== "missing_models" || !client.runtimeId) return result;
        return { ...result, next: client.cloudModelInstallVersion === 1
          ? "Use cloud_install_models on the active plan, then check readiness again."
          : "This runtime predates in-place model installation. Explain the blocker and ask before starting another Pod." };
      }));
      return { ...setup, ...(media === "speech" ? { voiceGuide: voiceGuide(setup.speakers) } : {}), workspaceDir };
    }, { idempotentHint: true });
  tool("create_project", "Save a multi-scene project. Defaults to 256×256 at 24 fps and generated audio.",
    { ...projectSettings, scenes: z.array(scene).min(1).max(100) }, (input) => projects.create(input));
  tool("import_project", "Save a copy of a Happy Latent project. Include sceneMemory from get_project to preserve pinned assignments. Reference files and voices remain local to the original installation.",
    { project: z.record(z.string(), z.unknown()), sceneMemory: z.record(z.string(), z.unknown()).optional() },
    ({ project, sceneMemory }) => projects.import(project, sceneMemory));
  tool("get_project", "Read a saved project, its scene IDs, and revision. Omit revision to see the latest version.",
    query, ({ projectId, revision }) => projects.get(projectId, revision), readOnly);
  tool("edit_project",
    "Apply scene, project, and audio edits and save a new revision. add_clip, choose_take and detach_take are editing only: no generation. Changing a scene to generated or silent audio clears supplied audio in that scene.",
    { projectId: id, expectedRevision: revision, operations: z.array(operation).min(1).max(100) },
    async ({ projectId, expectedRevision, operations }) => {
      const resolved = [];
      const durations = new Map();
      for (const operation of operations) {
        if (operation.op === 'place_music') {
          const key = JSON.stringify(operation.asset);
          if (!durations.has(key)) durations.set(key, (await comfy.analyzeMusic({ asset: operation.asset })).analysis.durationSeconds);
          resolved.push({ ...operation, audioDurationSeconds: durations.get(key) });
        } else resolved.push(['add_clip', 'choose_take'].includes(operation.op)
          ? { ...operation, clip: (await comfy.getClip(operation.clipId)).clip } : operation);
      }
      return projects.edit(projectId, expectedRevision, resolved);
    });
  tool('list_clips', 'List durable video takes on the selected runtime, including earlier takes. Does not generate video.',
    { projectId: id.optional(), runId: id.optional() }, input => comfy.listClips(input), readOnly);
  tool('get_clip', 'Read a video take and its saved generation recipe from the selected runtime. Does not generate video.',
    { clipId: id }, ({ clipId }) => comfy.getClip(clipId), readOnly);
  tool('upscale_video', 'Apply LTX 2.5 spatial 2x AI upscaling and source-guided refinement to one saved video take on the selected runtime. Keeps FPS, frame count and soundtrack. Poll get_job and retrieve a separate reusable take with get_result. No model downloads or project edits. The source must be a short whole-number FPS take with dimensions divisible by 32. Reuse requestId only for exact retries.',
    { clipId: z.string().regex(/^[a-f0-9]{32}$/), requestId: id, prompt: z.string().trim().min(1).max(8000).optional()
      .describe('Optional visual description for refinement. Omit to preserve the source content.') },
    ({ clipId, requestId, prompt }) => comfy.upscaleVideo(clipId, { requestId, prompt }), { idempotentHint: true });
  tool("import_asset", "Upload a regular local image, audio, or video file from the configured workspace. Returns an inline image, playable audio excerpt plus waveform, or video contact sheet and local playback path. Video imports return a reusable clip; importing does not generate video. Show the preview immediately. Cloud transfers follow the remembered upload preference.",
    { kind: z.enum(["image", "audio", "video"]), path: z.string().min(1).max(4096), inlineAudio },
    ({ kind, path }) => comfy.uploadAsset(kind, path));
  tool("import_generated_image", "Import a PNG from a completed Happy Latent image job. Use the returned asset in generate_image references or as a video scene's opening image.",
    { ...jobQuery, imageIndex: z.number().int().min(0).max(3).optional().describe("Zero-based index for older jobs with multiple images.") },
    ({ jobId, imageIndex }) => comfy.importGeneratedImage(jobId, imageIndex));
  tool("import_generated_speech", "Import a completed Happy Latent speech job into ComfyUI. Use the returned audio asset and duration with edit_project place_audio.",
    { ...jobQuery, inlineAudio }, async ({ jobId }) => {
      const result = await speech.getResult(jobId);
      return comfy.uploadGeneratedSpeech(result.path);
    });
  tool('import_generated_music', 'Import a completed ACE-Step music job as an audio asset for plan_music/place_music. Shows an excerpt and measured duration. Does not add it to a project or replace dialogue.',
    musicPlaybackQuery, ({ jobId }) => comfy.importGeneratedMusic(jobId));
  tool('analyze_music', 'Analyze an actual imported recording or completed music job on the selected runtime. Returns energy, estimated beat timestamps/tempo, sections and candidate windows. Signal analysis only: no listening, vocal detection, lyrics transcription, mood or guaranteed drop labels. Does not generate music or edit a project.',
    { asset: asset.optional(), jobId: id.optional(), startSeconds: z.number().nonnegative().optional(),
      endSeconds: z.number().positive().optional(), targetDurationSeconds: z.number().positive().max(600).optional() },
    input => comfy.analyzeMusic(input), readOnly);
  tool('plan_music', 'Measure an imported music asset and propose a source excerpt for the full video, chosen scenes or explicit frame ranges. Returns exact place_music operations and evidence without editing. Adjacent scenes stay continuous. Too-short audio is rejected; never silently loops. Use video/storyboard context to choose the energy profile.',
    { ...query, ...musicPlacementRequest.shape }, async ({ projectId, revision, ...request }) => {
      const snapshot = await projects.get(projectId, revision);
      const { analysis } = await comfy.analyzeMusic({ asset: request.asset });
      return { ...planMusicPlacement(snapshot.project, request, analysis), projectId, revision: snapshot.revision };
    }, readOnly);
  tool('place_music', 'Analyze and add music to the full video, chosen scenes or frame ranges, saving a new revision. Preserves dialogue/effects; separate soundtrack layer with source trimming, gain and fades. No rendering or video generation. Repeating the same plan replaces its deterministic music cue IDs; use edit_project remove_music to remove cues. Export chosen takes to hear the mix.',
    { projectId: id, expectedRevision: revision, ...musicPlacementRequest.shape },
    async ({ projectId, expectedRevision, ...request }) => {
      const snapshot = await projects.get(projectId);
      if (snapshot.revision !== expectedRevision) throw new Error('Project changed. Read the latest revision before placing music.');
      const { analysis } = await comfy.analyzeMusic({ asset: request.asset });
      const plan = planMusicPlacement(snapshot.project, request, analysis);
      return { ...await projects.edit(projectId, expectedRevision, plan.operations), musicPlan: plan };
    });
  tool("validate_project", "Check project timing, audio, assets, runtime, and model readiness before generating.",
    { ...query, enhancements, ...renderOptions }, async ({ projectId, revision, enhancements, mode, sceneIds }) => {
      const snapshot = await projects.get(projectId, revision);
      return { ...await comfy.validate(validateForGeneration(projectWithMemory(snapshot), { mode, sceneIds }), { enhancements, mode, sceneIds }), projectId, revision: snapshot.revision };
    }, { idempotentHint: true });
  tool("generate_video", "Queue missing scenes or fresh takes for sceneIds, keeping other chosen clips. Returns individual clips plus a project or selection preview. Reuse requestId only for an exact retry.",
    { projectId: id, revision, requestId: id, enhancements, ...renderOptions },
    async ({ projectId, revision, requestId, enhancements, mode, sceneIds }) => {
      const snapshot = await projects.get(projectId, revision);
      return comfy.generate(validateForGeneration(projectWithMemory(snapshot), { mode, sceneIds }), { revision, requestId, enhancements, mode, sceneIds });
    }, { idempotentHint: true });
  tool('export_video', 'Assemble the chosen existing takes into one video without model inference. Every scene must have a chosen take. Queueing is explicit; timeline edits never export automatically.',
    { projectId: id, revision, requestId: id }, async ({ projectId, revision, requestId }) => {
      const snapshot = await projects.get(projectId, revision);
      return comfy.generate(snapshot.project, { revision, requestId, mode: 'export' });
    }, { idempotentHint: true });
  tool("generate_image", "Queue one Klein 4B image. Use this by default for Happy Latent images and missing video opening frames on the chosen runtime. Provide width and height in pixels. Omit references for text-to-image. Supply up to four ordered imported images to edit or compose a scene opening frame. Each reference starts with a centered crop at the output aspect ratio. Supply a crop to override it. Poll get_job, preview the PNG with get_result, and use import_generated_image to reuse it. Reuse requestId only for retries of the same request.",
    {
      prompt: z.string().min(1).max(16000).refine(value => !!value.trim(), "Image prompt cannot be blank."),
      width: z.number().int().min(256).max(2048).multipleOf(32).describe("Output width in pixels."),
      height: z.number().int().min(256).max(2048).multipleOf(32).describe("Output height in pixels."),
      seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      references: z.array(imageReference).max(4).optional(), requestId: id,
    },
    ({ requestId, ...request }) => comfy.generateImage(request, { requestId }), { idempotentHint: true });
  tool("generate_speech", "Queue one spoken line using local Kokoro 82M. Use an installed voice ID or a pinned character memory. Poll get_job and fetch the completed WAV with get_result. Reuse requestId only for exact retries.",
    {
      text: z.string().trim().min(1).max(1000),
      character: memorySelector.extend({ revision }).optional().describe("Pinned character memory revision. Supplies saved voice and speed."),
      speaker: z.string().trim().regex(/^[abefhip][fm]_[a-z0-9_]{1,29}$/).optional().describe("An installed Kokoro voice ID. Overrides the character's saved voice."),
      speed: z.number().min(0.5).max(2).optional().describe("Speaking rate multiplier. Defaults to 1."),
      requestId: id,
    },
    async request => speech.generate(await resolveCharacterSpeech(memory, request)), { idempotentHint: true });
  tool('generate_music', 'Queue ACE-Step 1.5 XL Turbo music on the selected local/Runpod ComfyUI runtime. Fixed XL checkpoint and 8-step sampling; no model downloads. Supports instrumental music or supplied lyrics. Poll get_job, fetch FLAC/playable excerpt with get_result, analyze_music, then import_generated_music for timeline placement. Reuse requestId only for exact retries.',
    { ...musicRequestFields, requestId: id }, ({ requestId, ...request }) => comfy.generateMusic(request, { requestId }), { idempotentHint: true });
  tool("get_job", "Check an owned generation job. Video/image jobs include observed scene, stage, sampling steps, elapsed time and stage-specific ETA when sufficient events are available. Whole-render ETA is not inferred; unavailable/stale observations are marked. Failed jobs include recovery suggestions without automatic retries.",
    jobQuery, ({ jobId }) => isSpeechJob(jobId) ? speech.getJob(jobId) : comfy.getJob(jobId), { idempotentHint: true });
  tool("cancel_job", "Cancel an owned video, image or music job on a ComfyUI version that supports scoped cancellation.",
    jobQuery, ({ jobId }) => {
      if (isSpeechJob(jobId)) throw new Error('Use get_job to follow speech jobs to completion. Cancellation is available for video, image and music jobs.');
      return comfy.cancelJob(jobId);
    }, { destructiveHint: true, idempotentHint: true });
  tool("get_result", "Fetch local media from a completed job. Image results include an inline reference preview, prompt and settings; speech includes playable audio, exact text, voice and speed; for music, embed preview.audioPath as a local audio player and link path for the full FLAC. Previously downloaded music can be replayed offline. Present these in chat immediately as each asset finishes. Preview failures retain usable local paths. New video jobs include individual reusable clips plus the assembled MP4, with project or selection scope. Does not change any saved project.",
    musicPlaybackQuery, async ({ jobId }) => {
      if (isSpeechJob(jobId)) return speech.getResult(jobId);
      return await library.cachedMusicResult(jobId) ?? comfy.getResult(jobId);
    }, { idempotentHint: true });
  tool("export_workflow", "Export an editable ComfyUI workflow JSON, or its API prompt format, to a local file.",
    { ...query, format: z.enum(["ui", "api"]).optional(), enhancements, ...renderOptions }, async ({ projectId, revision, format, enhancements, mode, sceneIds }) => {
      const snapshot = await projects.get(projectId, revision);
      return { ...await comfy.exportWorkflow(projectWithMemory(snapshot), { format, enhancements, mode, sceneIds }), projectId, revision: snapshot.revision };
    });

  let cleanup;
  const release = () => cleanup ??= (async () => {
    approvals.close();
    modelApprovals.close();
    await Promise.allSettled([modelReviews.close(), downloads.close(), cloud.close()]);
  })();
  const close = server.close.bind(server);
  server.close = async () => {
    process.off('SIGINT', terminate);
    process.off('SIGTERM', terminate);
    process.stdin.off('end', terminate);
    try { await close(); } finally { await release(); }
  };
  const disconnected = () => { release().catch(error => console.error(`Happy Latent shutdown: ${error.message}`)); };
  server.server.onclose = disconnected;
  const terminate = () => {
    server.close().catch(error => console.error(`Happy Latent shutdown: ${error.message}`)).finally(() => process.exit(0));
  };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  // The SDK transport does not translate stdin EOF into its onclose callback.
  process.stdin.once('end', terminate);
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}
