import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Comfy } from './comfy.mjs';
import { ManagedRuntime } from './runtime.mjs';
import { closeProgressMonitors } from './progress.mjs';
import { SshConnection, normalizeHostKey } from './cloud-ssh.mjs';
import { checkCloudIdentity } from './cloud-identity.mjs';
import { cloudModels, cloudRequirements, COMFY_REVISION, HF_SECRET_NAME } from './cloud-models.mjs';
import { assessStorage, DEFAULT_CONTAINER_DISK_GB, DEFAULT_VOLUME_GB, requireStorageSpace, TEMPORARY_CONTAINER_DISK_GB, WORKSPACE_MOUNT_PATH } from './cloud-storage.mjs';
import { validatePinnedTemplateImage, runtimeDependencyLock } from './cloud-provenance.mjs';
import { cloudApprovalPublicKey } from './cloud-approval.mjs';
import { ModelReviewPending } from './model-review.mjs';
import { checkedCloudAsset, cloudAssetKey, cloudDataHash, cloudDataScript, cloudTransferMessage } from './cloud-data.mjs';
import { ShutdownPreference } from './shutdown-preference.mjs';
import { runpodLaunchWarning, runpodStorageReminder } from './runpod-notices.mjs';
import { estimateCloudVideo, LAUNCH_STAGES, launchStatus, runpodPreflight, WORKER_STAGES } from './cloud-launch.mjs';
import { cloudSelectionPath, readOptional, save } from './cloud-state.mjs';

export { cloudRequirements };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEMPLATE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NODE_FILES = ['__init__.py', 'happylatent', 'extension', 'web', 'workflows/mcp', 'pyproject.toml', 'README.md', 'LICENSE'];
const QUOTE_LIFETIME_MS = 5 * 60_000;
const PROVISION_WINDOW_MS = 5 * 60_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const podName = plan => `happylatent-${plan.lease.runtimeId}`;
const encodedLease = lease => Buffer.from(JSON.stringify(lease)).toString('base64');
const limitNote = lease => 'Estimated session spend only. The in-Pod watchdog enforces the session deadline once it starts. Confirm Pod state using Runpod MCP. ' + runpodStorageReminder(lease);
const mediaRoot = lease => lease.networkVolumeId
  ? `/workspace/.happylatent-cloud/runtimes/${lease.runtimeId}/media` : '/workspace';
const terminalJob = status => ['completed', 'failed', 'cancelled'].includes(status);
const jobAssets = state => [...(state.output ? [state.output] : []), ...(state.outputs ?? []), ...(state.clips ?? []).map(clip => clip.asset)];

async function requireIdleQueue(comfy) {
  const queue = await comfy.json('/queue');
  if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)
      || queue.queue_running.length || queue.queue_pending.length) throw new Error('This action requires an empty generation queue.');
}

function validateTemplate(templateId, image) {
  if (typeof templateId !== 'string' || templateId !== templateId.trim() || !TEMPLATE_ID.test(templateId)) throw new Error('Select the official Runpod PyTorch templateId from the live Runpod catalog.');
  validatePinnedTemplateImage(image);
}

function setupInstructions(contextId, contextPath, launchTelemetry) {
  const destination = `/workspace/.happylatent-cloud/bundles/${contextId}`;
  return {
    upload: { source: contextPath, destination },
    command: ['python3', `${destination}/cloud/bootstrap.py`, '--start'],
    ...(launchTelemetry ? { statusCommand: ['python3', `${destination}/cloud/bootstrap.py`, '--status'] } : {}),
    hostKeyCommand: ['ssh-keygen', '-y', '-f', '/etc/ssh/ssh_host_ed25519_key'],
    note: 'Read the Pod SSH host key through authenticated Runpod exec. Upload the complete directory with pinned-host-key SCP and run the bootstrap through authenticated Runpod exec. On setup failure record it with cloud_setup_failed, then stop the verified Pod and confirm shutdown through Runpod MCP.',
  };
}

export function sessionBudget({ quotedHourlyUsd, maxHourlyUsd, maxTotalUsd, maxMinutes }, now = Date.now()) {
  for (const [key, value] of Object.entries({ quotedHourlyUsd, maxHourlyUsd, maxTotalUsd, maxMinutes })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive finite number.`);
  }
  if (!Number.isInteger(maxMinutes) || maxMinutes > 24 * 60) throw new Error('maxMinutes must be an integer from 1 to 1440.');
  if (quotedHourlyUsd > maxHourlyUsd) throw new Error('The quoted hourly rate exceeds the approved hourly limit.');
  const reserveSeconds = 60;
  const seconds = Math.floor(Math.min(maxMinutes * 60, maxTotalUsd / quotedHourlyUsd * 3600)) - reserveSeconds;
  if (seconds < 60) throw new Error('The session budget must cover at least two minutes, including a one-minute shutdown reserve.');
  return { quotedHourlyUsd, maxHourlyUsd, maxTotalUsd, maxMinutes, reserveSeconds, deadline: new Date(now + seconds * 1000).toISOString() };
}

async function copySource(source, destination) {
  await cp(source, destination, { recursive: true, filter: async path => {
    const name = basename(path);
    if (name === '__pycache__' || name.startsWith('.') || name.endsWith('.pyc')) return false;
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Cloud setup sources cannot contain symlinks: ${path}`);
    return true;
  } });
}

async function treeHash(directory) {
  const hash = createHash('sha256');
  async function visit(root, prefix = '') {
    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = `${prefix}${item.name}`;
      if (item.isDirectory()) await visit(join(root, item.name), `${name}/`);
      else if (item.isFile()) hash.update(name).update('\0').update(await readFile(join(root, item.name))).update('\0');
      else throw new Error('Unexpected entry in cloud setup bundle.');
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

export class Cloud {
  constructor(config, { sshFactory = options => new SshConnection(options), now = () => Date.now(), nodeRoot, confirmAction, approveDownloads, verifyPodStopped } = {}) {
    this.config = config;
    this.localRuntime = new ManagedRuntime(config);
    this.shutdownPreference = new ShutdownPreference(config.stateDir);
    this.root = join(config.stateDir, 'cloud');
    this.selectionPath = cloudSelectionPath(config);
    this.volumePath = this.selectionPath.replace(/active(.*)\.json$/, 'last-volume$1.json');
    this.now = now;
    this.sshFactory = sshFactory;
    this.nodeRoot = nodeRoot;
    for (const [name, callback] of Object.entries({ confirmAction, approveDownloads, verifyPodStopped })) {
      if (callback !== undefined && typeof callback !== 'function') throw new Error(`${name} must be a function.`);
    }
    this.confirmAction = confirmAction;
    this.approveDownloads = approveDownloads;
    this.pendingPlans = new Map();
    this.verifyPodStopped = verifyPodStopped;
    this.connection = undefined;
    this.queue = Promise.resolve();
  }

  // Capture one selected runtime for the whole operation. Switching targets may
  // not race an upload, submission, cancellation or result download.
  serial(work) {
    if (this.closing) return Promise.reject(new Error('The Happy Latent runtime connection is closing.'));
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  async directories() {
    for (const name of ['', 'plans', 'contexts', 'data']) await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
  }

  checkSsh(input) { return this.serial(async () => {
    const result = await checkCloudIdentity(input);
    await this.directories();
    await save(join(this.root, 'ssh.json'), { identityFile: result.identityFile,
      authentication: result.authentication, publicKey: result.publicKey, fingerprint: result.fingerprint });
    return result;
  }); }

  async preflight({ identityFile, authentication, provider, templateId, image, networkVolumeId, limits, media, spatialUpscale }) {
    let remembered = await readOptional(this.volumePath);
    if (!remembered) {
      const selected = await readOptional(this.selectionPath);
      if (selected?.planId) {
        const prior = await this.readPlan(selected.planId);
        const setup = await readOptional(this.setupPath(selected.planId));
        if (prior.lease.networkVolumeId && setup?.state === 'connected') remembered = { id: prior.lease.networkVolumeId };
      }
    }
    const models = cloudModels(media ?? 'both', { spatialUpscale });
    let candidate;
    if (remembered && (!networkVolumeId || remembered.id === networkVolumeId)) {
      const cached = models.map(model => ({ path: model.path, bytes: model.size,
        status: !remembered.hashes ? 'unknown' : remembered.hashes.includes(model.sha256) ? 'previously_verified' : 'unconfirmed' }));
      candidate = { id: remembered.id, verifiedAt: remembered.verifiedAt, models: cached,
        unverifiedModelBytes: cached.reduce((total, model) => total + (model.status === 'previously_verified' ? 0 : model.bytes), 0),
        note: 'Previously used in this profile. Confirm the volume, rate, idle state and GPU stock through Runpod before offering reuse. The worker rechecks the model hashes on launch.' };
    }
    const selected = await readOptional(join(this.root, 'ssh.json'));
    let pinnedImage;
    try { validateTemplate(templateId, image); pinnedImage = image; } catch { /* Report the template check below. */ }
    return { ...await runpodPreflight({ provider, templateId, image: pinnedImage, limits, volumeId: networkVolumeId,
      now: this.now(), checkQuote: quote => sessionBudget(quote, this.now()),
      checkIdentity: async () => {
        if (!identityFile && !selected?.identityFile) throw new Error('Select your dedicated SSH key with cloud_ssh_check or supply its absolute path.');
        return checkCloudIdentity({ identityFile: identityFile ?? selected.identityFile,
          authentication: authentication ?? (identityFile ? undefined : selected?.authentication) });
      } }), ...(candidate ? { reuseCandidate: candidate } : {}) };
  }

  bindingPath(planId) { return this.planPath(planId).replace(/\.json$/, '.binding.json'); }

  async bindPod(plan, podId) {
    if (!TEMPLATE_ID.test(podId ?? '')) throw new Error('Invalid Runpod Pod ID.');
    const existing = await this.setupPodId(plan);
    if (existing && existing !== podId) throw new Error('This plan is already bound to another Pod.');
    const path = this.bindingPath(plan.planId);
    await save(path, { podId }, { exclusive: true });
    if ((await readOptional(path)).podId !== podId) throw new Error('This plan is already bound to another Pod.');
  }

  async launchReport(plan) {
    const directory = dirname(this.setupPath(plan.planId));
    const stages = [...LAUNCH_STAGES, 'stopped'];
    const events = (await Promise.all(stages.map(stage => readOptional(join(directory, `launch-${stage}.json`))))).filter(Boolean);
    const ready = events.find(event => event.stage === 'ready');
    const models = await readOptional(join(directory, 'launch-models_verified.json'));
    if (ready && models) ready.modelCache = { verifiedFiles: models.verifiedFiles, cachedFiles: models.cachedFiles, missingAtStart: models.missingAtStart };
    return launchStatus(events, { now: this.now(), deadline: plan.lease.deadline,
      setupState: (await readOptional(this.setupPath(plan.planId)))?.state, podId: await this.setupPodId(plan) });
  }

  async writeLaunchEvent(plan, stage, fields = {}) {
    const directory = dirname(this.setupPath(plan.planId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return save(join(directory, `launch-${stage}.json`), { stage, at: new Date(this.now()).toISOString(), ...fields }, { exclusive: true });
  }

  trackLaunch({ planId, stage, pod, worker }) { return this.serial(async () => {
    const plan = await this.readPlan(planId);
    const before = await this.launchReport(plan);
    let launchClaimed;
    if (stage === 'allocating') {
      if (!before.events.length && !(await this.deployablePlan(plan)).provisionable) throw new Error('This plan is not eligible for a new allocation.');
      launchClaimed = await this.writeLaunchEvent(plan, stage);
    } else {
      if (pod?.name !== podName(plan) || pod.image !== plan.image || !pod.id) throw new Error('Use a provider read of the exact planned Pod name, image and ID.');
      const reconcileWatchdog = before.checkWorker && WORKER_STAGES.includes(stage);
      if (stage !== 'stopped' && before.status === 'stop_required' && stage !== 'allocated' && !reconcileWatchdog) return before;
      if (before.status === 'stopped' && stage !== 'stopped') return before;
      if (stage === 'stopped' && !['EXITED', 'TERMINATED'].includes(pod.status)) throw new Error('Read back EXITED or TERMINATED for the exact Pod through Runpod MCP.');
      if (stage !== 'stopped' && ['EXITED', 'TERMINATED'].includes(pod.status)) throw new Error('Record the provider-verified stopped stage for this Pod.');
      if (stage !== 'stopped' && stage !== 'allocated' && !before.events.some(event => event.stage === 'allocated')) {
        throw new Error('Record allocated with the verified Pod ID and GPU type first.');
      }
      const previousStage = { ssh_verified: 'allocated', bundle_uploaded: 'ssh_verified', bootstrap_started: 'bundle_uploaded' }[stage];
      if (previousStage && !before.events.some(event => event.stage === previousStage)) {
        throw new Error(`Record the ${previousStage} stage first.`);
      }
      if (WORKER_STAGES.includes(stage)) {
        if (!before.events.some(event => event.stage === 'bootstrap_started')) throw new Error('Record bootstrap_started first.');
        if (worker?.runtimeId !== plan.lease.runtimeId || worker.podId !== pod.id
              || worker.deadline !== plan.lease.deadline || !Object.hasOwn(worker.stages ?? {}, stage)
              || (stage === 'ready' && worker.status !== 'ready')) {
          throw new Error('Use the stage timestamps returned by the prepared authenticated bootstrap status command for this Pod.');
        }
        if (reconcileWatchdog) {
          const armedAt = Date.parse(worker.stages.watchdog_armed);
          if (!Number.isFinite(armedAt) || armedAt < Date.parse(plan.lease.createdAt) - 30_000
              || armedAt > Date.parse(before.timeoutAt)
              || !['armed', 'running'].includes(worker.watchdogStatus)
              || !WORKER_STAGES.includes(worker.status) || this.now() >= Date.parse(plan.lease.deadline)) return before;
        }
      }
      await this.bindPod(plan, pod.id);
      if (stage === 'stopped') {
        await this.writeLaunchEvent(plan, stage, { providerStatus: pod.status });
      } else if (WORKER_STAGES.includes(stage)) {
        for (const observed of WORKER_STAGES) {
          const time = Date.parse(worker.stages?.[observed]);
          if (WORKER_STAGES.indexOf(observed) > WORKER_STAGES.indexOf(stage) || !Number.isFinite(time)
              || time < Date.parse(plan.lease.createdAt) - 30_000 || time > this.now() + 30_000) continue;
          await this.writeLaunchEvent(plan, observed, { at: new Date(time).toISOString() });
        }
      } else {
        await this.writeLaunchEvent(plan, stage, stage === 'allocated' ? { gpuId: pod.gpuId } : {});
      }
    }
    const result = await this.launchReport(await this.readPlan(planId));
    return { ...result, ...(launchClaimed === undefined ? {} : { launchClaimed: launchClaimed && result.status === 'in_progress' }) };
  }); }

  async videoEstimate({ planId, samplePlanId = planId, sampleJobId, shotFrames, orientation = 'landscape', gpuId }) {
    const [plan, samplePlan] = await Promise.all([this.readPlan(planId), this.readPlan(samplePlanId)]);
    const [launch, sampleLaunch] = await Promise.all([this.launchReport(plan), this.launchReport(samplePlan)]);
    if (sampleJobId !== undefined && !UUID.test(sampleJobId)) throw new Error('Use a representative Happy Latent job UUID.');
    const sample = sampleJobId ? await readOptional(join(this.config.stateDir, 'jobs', sampleJobId, 'video-timing.json')) : undefined;
    const allocatedGpu = launch.events.find(event => event.stage === 'allocated')?.gpuId;
    const targetGpu = allocatedGpu ?? gpuId;
    const sampleGpu = sampleLaunch.events.find(event => event.stage === 'allocated')?.gpuId;
    const [width, height] = orientation === 'portrait' ? [576, 1024] : [1024, 576];
    const enhancement = sample?.enhancements;
    const verifiedSample = sample?.runtimeId === samplePlan.lease.runtimeId && targetGpu && targetGpu === sampleGpu &&
      samplePlan.image === plan.image && sample.width === width && sample.height === height && sample.fps === 24 &&
      enhancement?.spatialUpscale === true && enhancement.refine === true && enhancement.temporalUpscale === false &&
      [sample.renderSeconds, sample.refinementSeconds, sample.retrievalSeconds].every(seconds => Number.isFinite(seconds) && seconds > 0);
    const launchedAt = Date.parse(sampleLaunch.events.find(event => event.stage === 'allocating')?.at);
    const ready = sampleLaunch.events.find(event => event.stage === 'ready');
    const setupTiming = (Date.parse(ready?.at) - launchedAt) / 1000;
    // A cached startup is only comparable on the same shared volume with
    // the same verified manifest. Weights are still rechecked on deployment.
    const sameStorage = (plan.lease.networkVolumeId ?? plan.lease.containerDiskGb ?? null)
      === (samplePlan.lease.networkVolumeId ?? samplePlan.lease.containerDiskGb ?? null);
    const cached = ready?.modelCache?.cachedFiles;
    const cold = cached === 0;
    const sharedCache = Boolean(plan.lease.networkVolumeId && sameStorage && cached > 0 &&
      cached === ready?.modelCache?.verifiedFiles);
    const setupSeconds = launch.status === 'ready' ? 0
      : (cold || sharedCache) && sameStorage && plan.contextId === samplePlan.contextId && Number.isFinite(setupTiming) && setupTiming >= 0
        ? Math.max(0, Math.ceil(setupTiming * 1.25) - launch.elapsedSeconds) : null;
    const estimate = estimateCloudVideo({ launch, sample: verifiedSample ? {
      jobId: sampleJobId, gpuId: sampleGpu, width, height, fps: 24, frames: sample.frames,
      renderSeconds: sample.renderSeconds, refinementSeconds: sample.refinementSeconds, retrievalSeconds: sample.retrievalSeconds,
    } : undefined, shotFrames, setupSeconds, quotedHourlyUsd: plan.lease.budget.quotedHourlyUsd,
      availableSeconds: launch.status === 'stop_required' || launch.status === 'stopped'
        ? 0 : (Date.parse(plan.lease.deadline) - this.now()) / 1000 });
    return { ...estimate, ...(sharedCache && setupSeconds > 0 ? { startupAssumption: 'The same volume still contains the verified model weights.' } : {}),
      ...(Number.isFinite(setupTiming) ? { observedStartup: {
      seconds: setupTiming, modelCache: ready?.modelCache ?? { status: 'unknown' },
    } } : {}) };
  }


  planPath(id) {
    if (!UUID.test(id)) throw new Error('Use the planId returned by cloud_plan.');
    return join(this.root, 'plans', `${id}.json`);
  }

  async readPlan(id) {
    const plan = await readOptional(this.planPath(id));
    if (!plan) throw new Error('Cloud plan was not found in this state directory.');
    const binding = await readOptional(this.bindingPath(id));
    if (binding) {
      if (plan.podId && plan.podId !== binding.podId) throw new Error('Cloud plan and immutable Pod binding disagree.');
      plan.podId = binding.podId;
    }
    return plan;
  }

  setupPath(planId) {
    this.planPath(planId);
    // Reuse the original marker path so old plans keep their setup decisions.
    return join(this.root, 'guards', planId, 'setup.json');
  }

  async prepare({ media = 'both', templateId, image, spatialUpscale = false, ...extra } = {}) {
    if (Object.hasOwn(extra, 'baseImage')) throw new Error('cloud_prepare now uses a Runpod template: supply templateId and image from the official live catalog instead of baseImage.');
    if (Object.keys(extra).length) throw new Error('cloud_prepare accepts only media, templateId, image, and spatialUpscale.');
    validateTemplate(templateId, image);
    const models = cloudModels(media, { spatialUpscale });
    await this.directories();
    const temp = await mkdtemp(join(this.root, 'contexts', '.prepare-'));
    try {
      const candidates = this.nodeRoot ? [this.nodeRoot] : [fileURLToPath(new URL('../../../', import.meta.url)), fileURLToPath(new URL('../resources/node/', import.meta.url))];
      let source;
      for (const root of candidates) {
        try { if ((await lstat(join(root, 'happylatent/nodes.py'))).isFile()) { source = root; break; } }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!source) throw new Error('Cloud preparation requires the full Happy Latent source or a bundle containing resources/node.');
      for (const name of NODE_FILES) await copySource(join(source, name), join(temp, 'node', name));
      const runtime = fileURLToPath(new URL('./cloud-runtime/', import.meta.url));
      for (const name of ['worker.py', 'bootstrap.py']) await copySource(join(runtime, name), join(temp, 'cloud', name));
      const lock = await runtimeDependencyLock('cloud');
      if (lock.metadata.comfyRevision !== COMFY_REVISION) throw new Error('The dependency lock does not match the selected ComfyUI revision.');
      for (const name of ['runtime-requirements.txt', 'dependency-lock.json']) {
        await copySource(join(runtime, name), join(temp, 'cloud', name));
      }
      await writeFile(join(temp, 'models.json'), json(models));
      await writeFile(join(temp, 'setup.json'), json({ version: spatialUpscale ? 6 : 5, media, templateId, image, comfyRevision: COMFY_REVISION, launchTelemetry: true,
        ...(spatialUpscale ? { spatialUpscale } : {}),
        dependencyLockSha256: lock.sha256, requirementsSha256: lock.metadata.requirementsSha256,
        approvalPublicKey: await cloudApprovalPublicKey(this.config.stateDir) }));
      const contextId = await treeHash(temp);
      const contextPath = join(this.root, 'contexts', contextId);
      try { await rename(temp, contextPath); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      return {
        contextId, contextPath, media, templateId, image, comfyRevision: COMFY_REVISION, ...(spatialUpscale ? { spatialUpscale } : {}),
        setup: setupInstructions(contextId, contextPath, true),
        templateVerification: 'The caller must verify this templateId and image against the official live Runpod catalog. Local validation requires an immutable image digest in the official namespace; the caller must still verify its publisher/catalog provenance.',
        next: 'Read current GPU availability and the complete running price, then call cloud_plan. Create the Pod only while the plan is provisionable. Upload this bundle and run its bootstrap after creation.',
      };
    } finally { await rm(temp, { recursive: true, force: true }); }
  }

  plan(input) { return this.serial(() => this.makePlan(input)); }
  async makePlan({ requestId, contextId, sshPublicKey, quotedAt, networkVolumeId, storageMode,
    quotedHourlyUsd, maxHourlyUsd, maxTotalUsd, maxMinutes, ...extra }) {
    if (Object.hasOwn(extra, 'image')) throw new Error('cloud_plan derives image and templateId from cloud_prepare; do not supply image here.');
    if (Object.hasOwn(extra, 'hfSecretName')) throw new Error('The Hugging Face secret name is fixed to happy_latent_hf. The agent checks it through Runpod MCP; do not supply a secret name or token.');
    if (Object.keys(extra).length) throw new Error('Unsupported cloud_plan fields. Supply only the documented plan inputs; raw credentials are never accepted.');
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Supply a stable requestId for this deployment plan.');
    if (networkVolumeId !== undefined && (typeof networkVolumeId !== 'string' || !TEMPLATE_ID.test(networkVolumeId))) {
      throw new Error('Supply the exact existing Runpod Network Volume ID.');
    }
    if (storageMode !== undefined && storageMode !== 'container') throw new Error('Use storageMode "container" for a temporary container disk.');
    if (storageMode === 'container' && networkVolumeId) throw new Error('Choose either a temporary container disk or an existing Runpod Network Volume.');
    if (!/^[a-f0-9]{64}$/.test(contextId ?? '')) throw new Error('Use the contextId returned by cloud_prepare.');
    if (typeof sshPublicKey !== 'string' || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(sshPublicKey) || sshPublicKey.length > 8192) throw new Error('Supply one OpenSSH public key, never a private key.');
    sshPublicKey = normalizeHostKey(sshPublicKey);
    const limits = { quotedHourlyUsd, maxHourlyUsd, maxTotalUsd, maxMinutes };
    await this.directories();
    const contextPath = join(this.root, 'contexts', contextId);
    const setup = await readOptional(join(contextPath, 'setup.json'));
    if (!setup || ![3, 4, 5, 6].includes(setup.version) || await treeHash(contextPath) !== contextId) throw new Error('Prepared setup bundle is missing, changed, or from the old Docker workflow; run cloud_prepare again.');
    if (networkVolumeId && setup.version < 4) throw new Error('Run cloud_prepare again for a bundle that supports Network Volume reuse.');
    if (storageMode === 'container' && setup.version < 5) throw new Error('Run cloud_prepare again for a bundle that supports temporary container storage.');
    validateTemplate(setup.templateId, setup.image);
    const { templateId, image } = setup;
    const idBytes = sha(requestId).split('');
    idBytes[12] = '5';
    idBytes[16] = ((parseInt(idBytes[16], 16) & 3) | 8).toString(16);
    const idHash = idBytes.join('');
    const planId = `${idHash.slice(0, 8)}-${idHash.slice(8, 12)}-${idHash.slice(12, 16)}-${idHash.slice(16, 20)}-${idHash.slice(20, 32)}`;
    const prior = await readOptional(this.planPath(planId));
    // Existing immutable plans retain their original secret configuration on
    // retry. The convention applies only to new plans, never to an active lease.
    const hfSecretName = prior ? prior.hfSecretName : HF_SECRET_NAME;
    const digest = sha(json({ contextId, templateId, image, sshPublicKey, quotedAt, hfSecretName, limits, networkVolumeId, storageMode }));
    if (prior) {
      if (prior.digest !== digest) throw new Error('This requestId is already bound to a different cloud plan. Reuse the original plan; new spending needs a new requestId and authorization.');
      return this.deployablePlan(await this.readPlan(planId));
    }
    const now = this.now();
    for (const [id, pending] of this.pendingPlans) if (pending.expiresAt <= now) this.pendingPlans.delete(id);
    const at = Date.parse(quotedAt);
    if (!Number.isFinite(at) || at > now + 30_000 || now - at >= QUOTE_LIFETIME_MS) throw new Error('Use a live price quote from the last five minutes.');
    const pending = this.pendingPlans.get(planId);
    if (pending && pending.digest !== digest) {
      throw new Error('This requestId is awaiting approval for a different cloud plan. Use the original inputs or a new requestId.');
    }
    const { deadline, ...budget } = sessionBudget(limits, now);
    const lease = pending?.lease ?? {
      version: 1, runtimeId: randomUUID(), bundleId: contextId, createdAt: new Date(now).toISOString(),
      deadline, media: setup.media, budget, sshPublicKey, ...(networkVolumeId ? { networkVolumeId } : {}),
      ...(storageMode === 'container' ? { containerDiskGb: TEMPORARY_CONTAINER_DISK_GB } : {}),
    };
    const expiresAt = Math.min(Date.parse(lease.deadline), at + QUOTE_LIFETIME_MS);
    if (!this.approveDownloads) throw new Error('Cloud model downloads require client confirmation before provisioning. Use a client that supports the Happy Latent approval flow.');
    let downloadApproval;
    try {
      const models = cloudModels(setup.media, { spatialUpscale: setup.spatialUpscale });
      downloadApproval = await this.approveDownloads({ lease: structuredClone(lease), models, setup, contextId, expiresAt });
    } catch (error) {
      if (error instanceof ModelReviewPending) this.pendingPlans.set(planId, { digest, lease, expiresAt });
      throw error;
    }
    if (!downloadApproval || typeof downloadApproval !== 'object') throw new Error('Cloud model download approval was not granted.');
    if (this.now() >= expiresAt) throw new Error('The cloud approval expired. Get a fresh quote and review a new plan.');
    const provisionBy = new Date(Math.min(this.now() + PROVISION_WINDOW_MS, Date.parse(lease.deadline))).toISOString();
    const plan = { version: 3, planId, digest, contextId, templateId, image, quotedAt, hfSecretName,
      ...(setup.launchTelemetry === true ? { launchTelemetry: true } : {}),
      lease: { ...lease, downloadApproval }, provisionBy };
    if (!await save(this.planPath(planId), plan, { exclusive: true })) return this.makePlan({ requestId, contextId, sshPublicKey, quotedAt, networkVolumeId, storageMode, ...limits });
    this.pendingPlans.delete(planId);
    return this.deployablePlan(plan);
  }

  async deployablePlan(plan) {
    const expired = this.now() >= Date.parse(plan.lease.deadline);
    const template = plan.version === 2 || plan.version === 3;
    const provisionBy = plan.provisionBy ?? new Date(Math.min(
      Date.parse(plan.lease.createdAt) + PROVISION_WINDOW_MS, Date.parse(plan.lease.deadline),
    )).toISOString();
    const setupState = (await readOptional(this.setupPath(plan.planId)))?.state;
    const launch = await this.launchReport(plan);
    const podId = await this.setupPodId(plan);
    const { networkVolumeId, containerDiskGb } = plan.lease;
    const storage = containerDiskGb
      ? { disk: containerDiskGb, mounts: {} }
      : { templateId: plan.templateId, volumeMount: WORKSPACE_MOUNT_PATH, disk: DEFAULT_CONTAINER_DISK_GB,
        mounts: networkVolumeId ? { network: [{ volumeId: networkVolumeId, path: WORKSPACE_MOUNT_PATH }] }
          : { persistent: { size: DEFAULT_VOLUME_GB, path: WORKSPACE_MOUNT_PATH } } };
    const provisionable = template && !expired && !podId && !setupState && !launch.events.length && this.now() < Date.parse(provisionBy);
    return {
      planId: plan.planId, runtimeId: plan.lease.runtimeId, image: plan.image, podId, provisionable,
      provisionBy, setupState, launch, launchWarning: runpodLaunchWarning(plan.lease), networkVolumeId,
      ...(containerDiskGb ? { storageMode: 'container', containerDiskGb } : {}),
      ...(template ? { templateId: plan.templateId, setup: setupInstructions(plan.contextId, join(this.root, 'contexts', plan.contextId), plan.launchTelemetry) } : {}),
      ...(template && plan.hfSecretName ? { secretRequirement: {
        name: plan.hfSecretName, environmentVariable: 'HF_TOKEN',
        preflight: 'Before creating the Pod, the coordinating agent must confirm this exact name in Runpod secret metadata. If missing, direct the user to create it in Runpod Console Secrets and stop before spending. The local planner has not queried the account or read the token.',
      } } : {}),
      deadline: plan.lease.deadline, expired, budget: plan.lease.budget,
      ...(provisionable ? { deployment: {
        name: podName(plan),
        image: plan.image,
        startJupyter: false, startSsh: true,
        env: { HAPPYLATENT_CLOUD_LEASE: encodedLease(plan.lease), PUBLIC_KEY: plan.lease.sshPublicKey,
          ...(plan.hfSecretName ? { HF_TOKEN: `{{ RUNPOD_SECRET_${plan.hfSecretName} }}` } : {}),
        },
        publicPorts: ['22/tcp'], publicIpRequired: true,
        ...storage,
        note: containerDiskGb
          ? 'Use Runpod MCP to create one Secure Cloud Pod from the pinned image. Omit templateId from create-pod to avoid inheriting a persistent disk. Verify the returned disk size and empty mounts before uploading. Keep the image entrypoint, enable SSH, disable Jupyter, and expose only TCP 22. HF_TOKEN is a Runpod secret reference.'
          : 'Use Runpod MCP to create one Pod immediately with the exact planned mount. For a Network Volume, require Secure Cloud stock in its data center and verify the returned volume ID and mount path before uploading. Keep the stock entrypoint, enable SSH, disable Jupyter, and expose only TCP 22. Omit deploy-when-available queue settings. HF_TOKEN is a Runpod secret reference.',
      } } : {}),
      limitation: limitNote(plan.lease),
      retry: 'Before retrying create, use Runpod MCP to find the exact deployment.name (environment values may be redacted). A matching name is for reconciliation, not provider idempotency. Never create another Pod for the same plan after an ambiguous create result; multiple matches require resolving the ambiguity.',
    };
  }

  setupFailed(planId) { return this.serial(async () => {
    const plan = await this.readPlan(planId);
    const path = this.setupPath(planId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!await save(path, { state: 'failed' }, { exclusive: true }) && (await readOptional(path))?.state !== 'failed') {
      throw new Error('The runtime already connected. Use cloud_stop for a normal shutdown.');
    }
    return { status: 'setup_failed', podId: await this.setupPodId(await this.readPlan(planId)),
      podName: podName(plan), image: plan.image, leaseEnvironmentValue: encodedLease(plan.lease),
      next: 'Use Runpod MCP now to read the Pod by ID, or find it by its unique planned name if the create reply was lost. Verify its name and image, and match the lease environment value if Runpod exposes it. Verify ownership and confirm stop is available before requesting it. Read the same Pod again until Runpod confirms EXITED or TERMINATED. If ownership or shutdown cannot be verified, give the user the Runpod Pods link (https://console.runpod.io/pods) and the Pod name or ID.',
      storageReminder: runpodStorageReminder(plan.lease) };
  }); }

  async setupPodId(plan) {
    if (plan.podId || !plan.guardRequired) return plan.podId;
    // An older release may have discovered the Pod before its first connection.
    return (await readOptional(join(this.root, 'guards', plan.planId, 'status.json')))?.podId;
  }

  setShutdownPreference(mode) { return this.serial(async () => {
    const current = await this.shutdownPreference.read();
    if (current.mode === mode) return current;
    if (mode === 'stop_after_results') {
      if (!this.confirmAction || await this.confirmAction({ kind: 'cloud_shutdown_preference', manifest: { mode },
        message: 'Automatically stop future Happy Latent Runpod sessions after all jobs finish and their outputs are retrieved?' }) !== true) {
        throw new Error('Automatic cloud shutdown was not approved.');
      }
    }
    return this.shutdownPreference.set(mode);
  }); }

  async assertRemote(comfy, plan, { submitting = false } = {}) {
    const remote = await comfy.json('/happylatent/cloud');
    if (remote.runtimeId !== plan.lease.runtimeId || remote.podId !== plan.podId || remote.deadline !== plan.lease.deadline
        || remote.networkVolumeId !== plan.lease.networkVolumeId) throw new Error('Cloud identity or deadline mismatch. Refusing to use this tunnel.');
    comfy.cloudStorage = assessStorage(remote.storage, { now: this.now() });
    comfy.cloudModelInstallVersion = remote.modelInstallVersion;
    if (submitting) {
      if (this.now() >= Date.parse(plan.lease.deadline)) throw new Error('Cloud spending/lifetime limit reached; no new generation can be submitted.');
      const heartbeat = Date.parse(remote.watchdog?.heartbeatAt);
      if (!['armed', 'running'].includes(remote.watchdog?.status) || !Number.isFinite(heartbeat) || Math.abs(this.now() - heartbeat) > 30_000) throw new Error('The cloud shutdown watchdog is not healthy. Refusing paid generation.');
      if (remote.status !== 'ready') throw new Error('Cloud runtime is not ready for generation.');
      requireStorageSpace(comfy.cloudStorage);
    }
    return remote;
  }

  async modelInstallTarget(planId) {
    const selected = await readOptional(this.selectionPath);
    if (selected?.planId !== planId || !selected.enabled) throw new Error('Select the original Runpod session with connect_cloud before installing or checking its models.');
    const comfy = await this.current();
    if (comfy.cloudModelInstallVersion !== 1) throw new Error('This Pod was bootstrapped before in-place model installation was supported.');
    return this.connection;
  }

  async remoteModelInstall(plan, request) {
    const identity = { runtimeId: plan.lease.runtimeId, podId: plan.podId, bundleId: plan.lease.bundleId,
      deadline: plan.lease.deadline, ...(plan.lease.networkVolumeId ? { networkVolumeId: plan.lease.networkVolumeId } : {}) };
    const encoded = Buffer.from(JSON.stringify({ ...request, identity })).toString('base64');
    const input = `import base64, json, runpy
request = json.loads(base64.b64decode('${encoded}'))
bundle = request['identity']['bundleId']
import re
if not re.fullmatch(r'[a-f0-9]{64}', bundle):
    raise ValueError('Invalid setup bundle')
worker = runpy.run_path('/workspace/.happylatent-cloud/bundles/' + bundle + '/cloud/worker.py')
try:
    result = worker['model_install_request'](request)
except ValueError as error:
    result = {'error': str(error)}
except Exception as error:
    result = {'error': worker['safe_error'](error)}
print(json.dumps(result))
`;
    const response = await this.connection.ssh.run('python3 -', { input });
    let result;
    try { result = JSON.parse(response.stdout); } catch { /* Do not expose SSH output. */ }
    if (response.exitCode !== 0 || !result) throw new Error('Could not read model installation state on this Pod. Reconnect and retry with the same requestId.');
    if (result.error && !result.status) throw new Error(result.error);
    const statuses = request.operation === 'active' ? ['active', 'idle']
      : ['review', 'already_ready', 'queued', 'running', 'completed', 'failed', 'unknown'];
    if (result.installId !== request.installId || !statuses.includes(result.status)) {
      throw new Error('The Pod did not confirm the requested model installation.');
    }
    return { ...result, planId: plan.planId, podId: plan.podId, runtimeId: plan.lease.runtimeId, deadline: plan.lease.deadline };
  }

  installModels({ planId, requestId, media, spatialUpscale }) { return this.serial(async () => {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Supply a stable requestId for this model installation.');
    const { comfy, plan } = await this.modelInstallTarget(planId);
    const installId = sha(requestId);
    const models = cloudModels(media, { spatialUpscale });
    await this.assertRemote(comfy, plan, { submitting: true });
    const review = await this.remoteModelInstall(plan, { operation: 'preview', installId, models });
    if (review.status !== 'review') return review;
    if (!Array.isArray(review.files)) throw new Error('The Pod returned an invalid model download list.');
    const missing = models.filter(model => review.files.includes(model.path));
    if (!missing.length || missing.length !== review.files.length
        || missing.some((model, index) => model.path !== review.files[index])
        || review.totalBytes !== missing.reduce((total, file) => total + file.size, 0)) throw new Error('The Pod returned an invalid model download list.');
    const setup = await readOptional(join(this.root, 'contexts', plan.lease.bundleId, 'setup.json'));
    if (!setup || setup.comfyRevision !== COMFY_REVISION) throw new Error('The selected Pod’s original setup is missing or its ComfyUI revision differs from this release.');
    if (!this.approveDownloads) throw new Error('Model downloads require client confirmation.');
    const installation = { installId, podId: plan.podId };
    const approval = await this.approveDownloads({ lease: structuredClone(plan.lease), models: missing, setup,
      expiresAt: Date.parse(plan.lease.deadline), installation });
    if (!approval || typeof approval !== 'object') throw new Error('Model download approval was not granted.');
    await this.modelInstallTarget(planId);
    await this.assertRemote(comfy, plan, { submitting: true });
    return this.remoteModelInstall(plan, { operation: 'enqueue', installId, models, files: review.files, approval });
  }); }

  modelInstallStatus({ planId, installId }) { return this.serial(async () => {
    if (!/^[a-f0-9]{64}$/.test(installId)) throw new Error('Use the installId returned by cloud_install_models.');
    const { plan } = await this.modelInstallTarget(planId);
    return this.remoteModelInstall(plan, { operation: 'status', installId });
  }); }

  async confirmTransfer(plan, transfer) {
    if (this.now() >= Date.parse(plan.lease.deadline)) throw new Error('Cloud session expired before the data transfer.');
    const manifest = { version: 1, ...structuredClone(transfer), provider: 'Runpod',
      runtimeId: plan.lease.runtimeId, podId: plan.podId, expiresAt: plan.lease.deadline };
    if (transfer.operation === 'upload' && plan.lease.networkVolumeId) {
      manifest.destination = mediaRoot(plan.lease) + '/input/happylatent';
    }
    if (!this.confirmAction || await this.confirmAction({ kind: 'cloud_transfer', manifest,
      message: cloudTransferMessage(manifest) }) !== true) {
      throw new Error('Cloud data transfer was not approved. No media or generation prompt was sent.');
    }
    if (this.now() >= Date.parse(plan.lease.deadline)) throw new Error('Cloud session expired while awaiting approval.');
    return true;
  }

  async dataDirectory(plan) {
    if (!UUID.test(plan.lease.runtimeId)) throw new Error('Invalid cloud runtime identity.');
    const directory = join(this.root, 'data', plan.lease.runtimeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async recordTransfer(plan, receipt) {
    const asset = checkedCloudAsset(receipt.asset);
    const record = { version: 1, runtimeId: plan.lease.runtimeId, podId: plan.podId, asset,
      category: receipt.direction === 'upload' ? 'inputs' : 'outputs' };
    if (receipt.direction === 'download') {
      if (typeof receipt.path !== 'string' || !resolve(receipt.path).startsWith(resolve(this.config.stateDir, 'results') + '/')
          || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error('Invalid local result receipt.');
      record.retrieved = { path: receipt.path, bytes: receipt.bytes, sha256: receipt.sha256 };
    }
    const directory = await this.dataDirectory(plan);
    await save(join(directory, cloudDataHash(asset) + '.json'), record);
    if (receipt.direction === 'upload' && /^[a-f0-9]{32}$/.test(receipt.clip?.id ?? '')) {
      const companion = { type: 'output', subfolder: 'happylatent/clips', filename: receipt.clip.id + '.json' };
      await save(join(directory, cloudDataHash(companion) + '.json'), { ...record, asset: companion, metadata: true });
    }
  }

  async dataRecords(plan) {
    const directory = await this.dataDirectory(plan);
    const records = new Map();
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      if (!(await lstat(path)).isFile()) throw new Error('Unsafe cloud receipt file.');
      const record = await readOptional(path);
      if (record.runtimeId !== plan.lease.runtimeId || record.podId !== plan.podId
          || !['inputs', 'outputs'].includes(record.category)) throw new Error('Cloud media receipt identity mismatch.');
      record.asset = checkedCloudAsset(record.asset);
      records.set(cloudAssetKey(record.asset), record);
    }
    return records;
  }

  async retrievedResult(record) {
    const receipt = record?.retrieved;
    if (!receipt || typeof receipt.path !== 'string' || !resolve(receipt.path).startsWith(resolve(this.config.stateDir, 'results') + '/')) return false;
    try {
      const info = await lstat(receipt.path);
      if (!info.isFile() || info.size !== receipt.bytes) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(receipt.path)) hash.update(chunk);
      return hash.digest('hex') === receipt.sha256;
    } catch { return false; }
  }

  async remoteData(plan, request) {
    const response = await this.connection.ssh.run('python3 -', {
      input: await cloudDataScript({ ...request, runtimeId: plan.lease.runtimeId, podId: plan.podId,
        ...(plan.lease.networkVolumeId ? { networkVolumeId: plan.lease.networkVolumeId } : {}) }), timeoutMs: 300000,
    });
    let result;
    try { result = JSON.parse(response.stdout); } catch { /* Fail without printing remote data. */ }
    if (response.exitCode !== 0 || !result || result.error || !Array.isArray(result.files) || !Array.isArray(result.missing)) {
      throw new Error('Cloud files changed or could not be safely accessed. Refresh the inventory before retrying.');
    }
    const allowed = new Map(request.files.map(file => [cloudAssetKey(file.asset), file]));
    for (const file of result.files) {
      file.asset = checkedCloudAsset(file.asset);
      if (!allowed.has(cloudAssetKey(file.asset)) || file.category !== allowed.get(cloudAssetKey(file.asset)).category
          || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error('The cloud inventory did not match the requested files.');
      }
    }
    if (request.operation === 'delete' && (result.files.length !== request.files.length || result.missing.length
        || result.files.some(file => { const approved = allowed.get(cloudAssetKey(file.asset));
          return approved.sha256 !== file.sha256 || approved.bytes !== file.bytes; }))) {
      throw new Error('Cloud deletion did not confirm the complete approved file list.');
    }
    return result;
  }

  async *cloudJobs(comfy, plan) {
    const receipts = await this.dataDirectory(plan);
    const jobRoot = join(this.config.stateDir, 'jobs');
    let directories = [];
    try { directories = await readdir(jobRoot, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of directories) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const job = await readOptional(join(jobRoot, entry.name, 'job.json'));
      if (job?.runtimeId !== plan.lease.runtimeId) continue;
      if (job.id !== entry.name) throw new Error('Cloud job record identity mismatch.');
      const deleted = await readOptional(join(receipts, `history-${job.id}.json`));
      if (deleted?.deleted === true && deleted.runtimeId === plan.lease.runtimeId && deleted.podId === plan.podId && deleted.jobId === job.id) continue;
      yield { job, state: await comfy.getJob(job.id) };
    }
  }

  async dataInventory(scope = 'all') {
    if (!['inputs', 'outputs', 'all'].includes(scope)) throw new Error('Cleanup scope must be inputs, outputs or all.');
    const comfy = await this.current();
    if (!this.connection || comfy.runtimeId === undefined) throw new Error('Connect the cloud runtime before inspecting its media.');
    const plan = this.connection.plan;
    const records = await this.dataRecords(plan);
    const jobs = [];
    const unfinished = [];
    for await (const { job, state } of this.cloudJobs(comfy, plan)) {
      if (!terminalJob(state.status)) {
        unfinished.push({ jobId: job.id, status: state.status });
        continue;
      }
      const assets = jobAssets(state);
      const retrieved = new Map();
      for (const value of assets) {
        const asset = checkedCloudAsset(value);
        const key = cloudAssetKey(asset);
        const prior = records.get(key);
        records.set(key, { ...prior, asset, category: 'outputs', jobId: job.id });
        retrieved.set(key, await this.retrievedResult(prior));
      }
      const allRetrieved = assets.length > 0 && [...retrieved.values()].every(Boolean);
      for (const clip of state.clips ?? []) {
        if (!/^[a-f0-9]{32}$/.test(clip.id)) throw new Error('Invalid cloud clip metadata.');
        const asset = { type: 'output', subfolder: 'happylatent/clips', filename: clip.id + '.json' };
        records.set(cloudAssetKey(asset), { asset, category: 'outputs', metadata: true, mediaRetrieved: allRetrieved, jobId: job.id });
      }
      if (job.clips) {
        const asset = { type: 'output', subfolder: 'happylatent/runs', filename: sha(job.id) + '.json' };
        records.set(cloudAssetKey(asset), { asset, category: 'outputs', metadata: true, mediaRetrieved: allRetrieved, jobId: job.id });
      }
      if (!UUID.test(state.promptId ?? job.id)) throw new Error('Invalid owned cloud prompt identity.');
      jobs.push({ jobId: job.id, promptId: state.promptId ?? job.id, status: state.status,
        retrieved: allRetrieved || state.status !== 'completed' && assets.length === 0 });
    }
    const selected = [...records.values()].filter(record => scope === 'all' || record.category === scope);
    const result = await this.remoteData(plan, { operation: 'inventory', files: selected.map(({ asset, category }) => ({ asset, category })) });
    const files = [];
    for (const file of result.files) {
      const record = records.get(cloudAssetKey(file.asset));
      const retrieved = record.category === 'inputs' || record.metadata ? record.category === 'inputs' || record.mediaRetrieved === true
        : await this.retrievedResult(record) && record.retrieved.sha256 === file.sha256 && record.retrieved.bytes === file.bytes;
      files.push({ ...file, path: mediaRoot(plan.lease) + '/' + cloudAssetKey(file.asset), retrieved });
    }
    const history = scope === 'inputs' ? [] : jobs.map(job => ({ ...job, contents: 'Generation prompts, settings and media references' }));
    return { version: 1, provider: 'Runpod', runtimeId: plan.lease.runtimeId, podId: plan.podId, scope,
      files, history, unfinished, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      retained: 'Models, dependencies, shared files, runtime logs, and unrelated jobs are retained. Cleanup does not stop compute or delete the Pod/volume.' };
  }

  inventoryData(input = {}) { return this.serial(() => this.dataInventory(input.scope ?? 'all')); }

  async cleanupData(input = {}, { signal } = {}) {
    if (Object.keys(input).some(key => key !== 'scope')) throw new Error('Cleanup accepts only a scope; approval comes from the client confirmation.');
    const { inventory, plan } = await this.serial(async () => {
      const inventory = await this.dataInventory(input.scope ?? 'all');
      if (inventory.unfinished.length) throw new Error('Wait for this runtime’s active or uncertain jobs to finish before cloud cleanup.');
      if (inventory.files.some(file => !file.retrieved) || inventory.history.some(job => !job.retrieved)) {
        throw new Error('Retrieve every completed output with get_result before deleting its cloud copy or generation history.');
      }
      await requireIdleQueue(this.connection.comfy);
      return { inventory, plan: this.connection.plan };
    });
    if (!inventory.files.length && !inventory.history.length) return { status: 'nothing_to_delete', ...inventory };
    // Keep time for a verified stop when the confirmation client is unavailable.
    const confirmBy = Math.min(this.now() + 45_000, Date.parse(plan.lease.deadline) - 60_000);
    const timeoutMs = confirmBy - this.now();
    if (timeoutMs <= 0) throw new Error('The cloud session is too close to shutdown for cleanup confirmation. Retrieved copies are available locally.');
    const rows = inventory.files.map(file => `${file.path} — ${(file.bytes / 1e9).toFixed(3)} GB`).join('\n');
    const history = inventory.history.map(job => `Prompt/history for job ${job.jobId}`).join('\n');
    const message = `Delete these Happy Latent files from Runpod Pod ${inventory.podId}?\n\n${rows}\n${history}\n\nTotal files: ${inventory.files.length}; ${(inventory.totalBytes / 1e9).toFixed(3)} GB. Local retrieved copies are retained. Cloud project references to deleted media will stop working.\n\n${inventory.retained}`;
    if (!this.confirmAction || await this.confirmAction({ kind: 'cloud_cleanup', manifest: inventory, message, timeoutMs }) !== true) {
      throw new Error('Cloud cleanup was not approved. No files were deleted.');
    }
    // A pending client dialog must leave status, disconnect and stop available.
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (this.now() >= confirmBy) throw new Error('Cloud cleanup confirmation expired. No files were deleted.');
      if (this.connection?.plan !== plan) throw new Error('The cloud connection changed while awaiting cleanup confirmation. Review a fresh cleanup request.');
      const comfy = this.connection.comfy;
      await this.assertRemote(comfy, plan);
      await requireIdleQueue(comfy);
      const latest = await this.dataInventory(inventory.scope);
      if (cloudDataHash(latest) !== cloudDataHash(inventory)) throw new Error('The cloud cleanup list changed. Review a fresh cleanup request.');
      await requireIdleQueue(comfy);
      signal?.throwIfAborted();
      const receipts = await this.dataDirectory(plan);
      let files = [];
      try {
        if (inventory.files.length) {
          const result = await this.remoteData(plan, { operation: 'delete', files: inventory.files });
          if (!result.deleted) throw new Error('Cloud deletion was not confirmed.');
          files = result.files;
        }
        if (inventory.history.length) {
          await requireIdleQueue(comfy);
          const response = await comfy.response('/history', { json: { delete: inventory.history.map(job => job.promptId) } });
          await response.body?.cancel();
          for (const job of inventory.history) {
            const history = await comfy.json(`/history/${job.promptId}`);
            if (!history || typeof history !== 'object' || Array.isArray(history) || Object.hasOwn(history, job.promptId)) {
              throw new Error('Prompt history deletion could not be verified.');
            }
            await save(join(receipts, `history-${job.jobId}.json`), { runtimeId: inventory.runtimeId, podId: inventory.podId, jobId: job.jobId, promptId: job.promptId, deleted: true });
          }
        }
      } catch (error) {
        throw new Error('Cloud cleanup may have partially completed. Retry to review and remove the remaining files and prompt history.', { cause: error });
      }
      // Keep output retrieval receipts until the associated prompt history is gone.
      for (const file of files) {
        if (file.category === 'inputs' || inventory.history.length) await rm(join(receipts, cloudDataHash(file.asset) + '.json'), { force: true });
      }
      return { status: 'deleted', podId: inventory.podId, runtimeId: inventory.runtimeId,
        files: files.map(file => mediaRoot(plan.lease) + '/' + cloudAssetKey(file.asset)), bytes: inventory.totalBytes,
        historyDeleted: inventory.history.length > 0, podStopped: false, storageDeleted: false, note: inventory.retained };
    });
  }

  async attach(plan) {
    const ssh = this.sshFactory(plan.ssh);
    try {
      const tunnel = await ssh.connectTunnel();
      const comfy = new Comfy({ comfyUrl: tunnel.url, dataDir: this.config.stateDir, assetRoot: this.config.workspaceDir, runtimeId: plan.lease.runtimeId, monitorProgress: true,
        beforeSubmit: () => this.assertRemote(comfy, plan, { submitting: true }),
        beforeTransfer: async manifest => {
          if (manifest.operation === 'upload') {
            const remote = await this.assertRemote(comfy, plan);
            const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
            const storage = assessStorage(remote.storage, { now: this.now(), requiredFreeGb: bytes / 1e9 });
            requireStorageSpace(storage);
          }
          await this.confirmTransfer(plan, manifest);
          if (manifest.operation === 'upload') {
            // Space may change while the client is asking for transfer consent.
            const remote = await this.assertRemote(comfy, plan);
            requireStorageSpace(assessStorage(remote.storage, { now: this.now(),
              requiredFreeGb: manifest.files.reduce((sum, file) => sum + file.bytes, 0) / 1e9 }));
          }
          return true;
        },
        afterTransfer: receipt => this.recordTransfer(plan, receipt) });
      const remote = await this.assertRemote(comfy, plan);
      const path = this.setupPath(plan.planId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (!await save(path, { state: 'connected', podId: plan.podId }, { exclusive: true })) {
        const saved = await readOptional(path);
        if (saved?.state !== 'connected' || saved.podId !== plan.podId) {
          throw new Error('This Runpod setup has already been marked as failed or bound to another Pod.');
        }
      }
      const verified = remote.verifiedModels?.filter(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
      const cached = remote.cachedModels?.filter(hash => verified?.includes(hash));
      if (verified && cached) await this.writeLaunchEvent(plan, 'models_verified', {
        verifiedFiles: verified.length, cachedFiles: cached.length, missingAtStart: verified.length - cached.length,
      });
      if (remote.status === 'ready') await this.writeLaunchEvent(plan, 'ready');
      if (plan.lease.networkVolumeId) {
        const previous = await readOptional(this.volumePath);
        const known = previous?.id === plan.lease.networkVolumeId ? previous.hashes : undefined;
        const hashes = verified ? [...new Set([...(known ?? []), ...verified])] : known;
        await save(this.volumePath, { id: plan.lease.networkVolumeId, verifiedAt: new Date(this.now()).toISOString(), hashes });
      }
      return { ssh, comfy, plan };
    } catch (error) { await ssh.close(); throw error; }
  }

  connect(input) { return this.serial(async () => {
    const plan = await this.readPlan(input.planId);
    if (input.podId && !/^[a-zA-Z0-9_-]{1,128}$/.test(input.podId)) throw new Error('Invalid Runpod Pod ID.');
    const setupPodId = await this.setupPodId(plan);
    if (setupPodId && input.podId && input.podId !== setupPodId) throw new Error('This plan is already bound to another Pod.');
    const launch = await this.launchReport(plan);
    if (launch.checkWorker) {
      throw new Error('The watchdog checkpoint is missing. Read the authenticated setup status and record the worker stage with cloud_track_launch before connecting.');
    }
    if (launch.status === 'stop_required' || (await readOptional(this.setupPath(plan.planId)))?.state === 'failed') {
      throw new Error('This Runpod setup was marked as failed. Verify shutdown through Runpod MCP.');
    }
    if (input.host === undefined && (input.identityFile !== undefined || input.authentication !== undefined || input.port !== undefined || input.hostKey !== undefined)) {
      throw new Error('Supply host and its verified hostKey when changing SSH connection settings. Use planId alone to reconnect.');
    }
    if (input.host !== undefined) {
      const selected = await readOptional(join(this.root, 'ssh.json'));
      const identityFile = input.identityFile ?? plan.ssh?.identityFile ?? selected?.identityFile;
      if (!identityFile) throw new Error('Complete manual SSH setup and run cloud_ssh_check with your key path before connecting.');
      const authentication = input.authentication ?? (identityFile === plan.ssh?.identityFile ? plan.ssh.authentication : undefined)
        ?? (identityFile === selected?.identityFile ? selected.authentication : undefined) ?? 'file';
      if (identityFile === selected?.identityFile && selected.publicKey !== plan.lease.sshPublicKey) {
        throw new Error('The selected SSH key belongs to a different plan. Reconnect with the original key; do not replace the active Pod.');
      }
      const candidate = { host: input.host, port: input.port ?? 22, user: 'root', identityFile: resolve(identityFile), hostKey: input.hostKey, authentication,
        ...(authentication === 'agent' ? { publicKey: plan.lease.sshPublicKey } : {}) };
      if (!['agent', 'file'].includes(authentication)) throw new Error('SSH authentication must be agent or file.');
      // The host can change after a provider restart. A changed host key must be
      // supplied again from authenticated provider exec, never from ssh-keyscan.
      plan.ssh = candidate;
    }
    plan.podId = setupPodId ?? input.podId;
    if (!plan.podId || !plan.ssh) throw new Error('First connection requires podId, host, port, and the verified public hostKey from authenticated Runpod exec. Use cloud_ssh_check to remember your manually configured key.');
    await this.bindPod(plan, plan.podId);
    // Bind before opening the connection; an interrupted attach must not free
    // this plan for a second paid Pod.
    await save(this.planPath(plan.planId), plan);
    await closeProgressMonitors({ dataDir: this.config.stateDir });
    await this.connection?.ssh.close();
    this.connection = undefined;
    await save(this.selectionPath, { planId: plan.planId, enabled: true });
    this.connection = await this.attach(plan);
    return { ...await this.inspect(), next: 'Run check_setup for the requested media, then use the regular generation tools.' };
  }); }

  async current() {
    const selected = await readOptional(this.selectionPath);
    if (!selected) {
      await this.localRuntime.ensure();
      return new Comfy({ comfyUrl: this.config.comfyUrl, dataDir: this.config.stateDir, assetRoot: this.config.workspaceDir, monitorProgress: true });
    }
    if (this.config.localOnly) throw new Error('Local verification cannot use a selected cloud runtime. Choose the local backend first.');
    if (!selected.enabled) throw new Error('Cloud tunnel is disconnected. Reconnect with connect_cloud or explicitly choose useLocal in disconnect_cloud.');
    if (this.connection && this.connection.plan.planId !== selected.planId) {
      await closeProgressMonitors({ dataDir: this.config.stateDir, runtimeId: this.connection.plan.lease.runtimeId });
      await this.connection.ssh.close();
      this.connection = undefined;
    }
    if (!this.connection) this.connection = await this.attach(await this.readPlan(selected.planId));
    await this.assertRemote(this.connection.comfy, this.connection.plan);
    return this.connection.comfy;
  }

  withComfy(work) { return this.serial(async () => {
    const comfy = await this.current();
    const result = await work(comfy);
    // current() refreshes the measurement on every tool call, including get_job.
    // Do not make a successful render/download depend on another network request.
    return comfy.runtimeId && result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, storage: comfy.cloudStorage } : result;
  }); }

  storageStatus({ requiredFreeGb = 0 } = {}) { return this.serial(async () => {
    const state = await this.inspect();
    if (state.target !== 'runpod') return { target: state.target, status: 'not_applicable', reason: 'No cloud runtime is selected.' };
    return { target: state.target, podId: state.podId,
      ...assessStorage(state.remote?.storage, { now: this.now(), requiredFreeGb }) };
  }); }

  status(planId) { return this.serial(async () => {
    if (planId === undefined) return this.inspect();
    const plan = await this.readPlan(planId);
    return { planId, runtimeId: plan.lease.runtimeId, deadline: plan.lease.deadline, networkVolumeId: plan.lease.networkVolumeId,
      ...(plan.lease.containerDiskGb ? { storageMode: 'container', containerDiskGb: plan.lease.containerDiskGb } : {}),
      podId: await this.setupPodId(plan), podName: podName(plan),
      setupState: (await readOptional(this.setupPath(planId)))?.state, launch: await this.launchReport(plan), limitation: limitNote(plan.lease) };
  }); }
  async inspect() {
    const selected = await readOptional(this.selectionPath);
    if (!selected) return { target: 'local', comfyUrl: this.config.comfyUrl };
    const plan = await this.readPlan(selected.planId);
    const elapsedHours = Math.max(0, this.now() - Date.parse(plan.lease.createdAt)) / 3_600_000;
    let remote, error;
    if (this.connection) {
      try { remote = await this.assertRemote(this.connection.comfy, plan); }
      catch (caught) { error = caught.message; }
    }
    return { target: 'runpod', planId: plan.planId, runtimeId: plan.lease.runtimeId, podId: plan.podId, networkVolumeId: plan.lease.networkVolumeId,
      ...(plan.lease.containerDiskGb ? { storageMode: 'container', containerDiskGb: plan.lease.containerDiskGb } : {}),
      connected: !!remote, reconnectEnabled: selected.enabled, deadline: plan.lease.deadline,
      expired: this.now() >= Date.parse(plan.lease.deadline), budget: plan.lease.budget, launch: await this.launchReport(plan),
      estimatedSpendUsd: Math.round(elapsedHours * plan.lease.budget.quotedHourlyUsd * 1e6) / 1e6,
      estimateBasis: 'Elapsed time since plan creation at the quoted running rate; not a billing read or proof the Pod is running.',
      storage: assessStorage(remote?.storage, { now: this.now() }),
      ...(remote ? { remote } : {}), ...(error ? { error } : {}),
      limitation: limitNote(plan.lease) };
  }

  disconnect({ useLocal = false } = {}) { return this.serial(async () => {
    await closeProgressMonitors({ dataDir: this.config.stateDir });
    await this.connection?.ssh.close();
    this.connection = undefined;
    const active = await readOptional(this.selectionPath);
    if (useLocal) await rm(this.selectionPath, { force: true });
    else if (active) await save(this.selectionPath, { ...active, enabled: false });
    return { disconnected: true, target: useLocal ? 'local' : 'disconnected', podStopped: false, cloudDataDeleted: false, note: 'Disconnecting the tunnel does not stop billing. The original watchdog deadline remains in effect.' };
  }); }

  stop() { return this.serial(async () => {
    const selected = await readOptional(this.selectionPath);
    if (!selected) throw new Error('No cloud Pod is selected.');
    const comfy = await this.current();
    const plan = this.connection.plan;
    const manifest = { runtimeId: plan.lease.runtimeId, podId: plan.podId };
    const check = async () => {
      await this.assertRemote(comfy, plan);
      if (comfy.cloudModelInstallVersion === 1 && (await this.remoteModelInstall(plan, { operation: 'active' })).status === 'active') {
        throw new Error('Wait for the active cloud model installation to finish before stopping.');
      }
      await requireIdleQueue(comfy);
      const records = await this.dataRecords(plan);
      for await (const { state } of this.cloudJobs(comfy, plan)) {
        if (!terminalJob(state.status)) throw new Error('Wait for this runtime’s active or uncertain jobs to finish before stopping.');
        const assets = jobAssets(state);
        if (state.status === 'completed' && (!assets.length || state.clipsUnavailable)) {
          throw new Error('Could not verify the completed cloud job outputs. Review them before stopping.');
        }
        for (const asset of assets) {
          if (!await this.retrievedResult(records.get(cloudAssetKey(checkedCloudAsset(asset))))) {
            throw new Error('Retrieve every completed output with get_result before stopping the Pod.');
          }
        }
      }
    };
    await check();
    if ((await this.shutdownPreference.read()).mode !== 'stop_after_results') {
      if (!this.confirmAction || await this.confirmAction({ kind: 'cloud_stop', manifest,
        message: `Stop Runpod Pod ${plan.podId}? Happy Latent has checked for active jobs and retrieved outputs. Compute stops once Runpod confirms shutdown. ${runpodStorageReminder(plan.lease)}` }) !== true) {
        throw new Error('Cloud shutdown was not approved.');
      }
      await check();
    }
    await requireIdleQueue(comfy);
    await comfy.json('/happylatent/cloud/stop', { json: manifest });
    let verified = false;
    if (this.verifyPodStopped) {
      try {
        const provider = await this.verifyPodStopped(plan.podId);
        verified = provider?.id === plan.podId && ['EXITED', 'TERMINATED'].includes(provider.status);
      } catch { /* A failed read is never proof of shutdown. */ }
    }
    return { status: verified ? 'stopped' : 'stop_requested', verified, podId: plan.podId,
      cloudDataDeleted: verified && Boolean(plan.lease.containerDiskGb), storageMayBeBillable: !verified || !plan.lease.containerDiskGb,
      verification: verified ? 'Provider read-back confirmed the exact Pod is stopped.' : 'Required: use Runpod MCP to read this exact Pod and confirm EXITED or TERMINATED. A closed tunnel is not verification.',
      note: runpodStorageReminder(plan.lease) };
  }); }

  close() {
    // Finish accepted tool operations before releasing their observers/tunnels;
    // otherwise a late get_job or submission could recreate a watcher afterward.
    return this.closing ??= this.queue.then(async () => {
      try {
        await closeProgressMonitors({ dataDir: this.config.stateDir });
        await this.connection?.ssh.close();
      }
      finally { this.connection = undefined; await this.localRuntime.close(); }
    });
  }
}
