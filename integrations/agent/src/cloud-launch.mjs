import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { normalizeHostKey } from './cloud-ssh.mjs';
import { HF_SECRET_NAME } from './cloud-models.mjs';

export const LAUNCH_STAGES = [
  'allocating', 'allocated', 'ssh_verified', 'bundle_uploaded', 'bootstrap_started',
  'watchdog_armed', 'installing', 'downloading', 'starting', 'ready',
];
export const WORKER_STAGES = ['watchdog_armed', 'installing', 'downloading', 'starting', 'ready'];
const SSH_TIMEOUT_MS = 4 * 60_000;
const WATCHDOG_TIMEOUT_MS = 3 * 60_000;

export async function runpodPreflight({ provider, templateId, image, limits, volumeId, checkIdentity, checkQuote, now }) {
  const checks = [];
  const add = (check, okay, fix) => checks.push({ check, status: okay ? 'ready' : 'blocked', ...(okay ? {} : { fix }) });
  try {
    await Promise.all(['/usr/bin/ssh', '/usr/bin/scp'].map(path => access(path, constants.X_OK)));
    add('ssh_tools', true);
  } catch {
    add('ssh_tools', false, 'Install the system OpenSSH client and SCP.');
  }
  let identity;
  try {
    identity = await checkIdentity();
    add('local_ssh_identity', true);
  } catch (error) {
    add('local_ssh_identity', false, error.message);
  }
  const observed = Date.parse(provider?.checkedAt);
  const fresh = observed <= now + 30_000 && now - observed < 5 * 60_000;
  add('runpod_sign_in', fresh && provider?.signedIn, 'Sign in to Runpod MCP and collect fresh account metadata.');
  const registered = identity && fresh && provider?.registeredPublicKeys?.some(key => {
    try { return normalizeHostKey(key) === identity.publicKey; } catch { return false; }
  });
  add('runpod_ssh_registration', registered, 'Match the local key against Runpod public keys. Add the selected .pub key in Runpod if it is missing.');
  add('hugging_face_secret', fresh && provider?.secretNames?.includes(HF_SECRET_NAME),
    'Check Runpod Secrets metadata for happy_latent_hf. Add the fine-grained read token in Runpod if needed, and verify gated-model access separately.');
  add('template', fresh && templateId && image && provider?.template?.id === templateId
      && provider.template.image === image && provider.template.python312 && provider.template.ssh && provider.template.git,
    'Verify the official PyTorch template, immutable image digest, Python 3.12, SSH and Git.');
  const gpu = fresh ? provider.gpu : undefined;
  add('gpu_capacity', gpu?.available && gpu.secureCloud && gpu.cudaCompatible,
    'Find a Secure Cloud GPU with current stock and CUDA support for the pinned image.');
  const volume = fresh && provider.volume?.id === volumeId && volumeId ? provider.volume : undefined;
  if (volumeId) add('network_volume', volume?.dataCenterId === gpu?.dataCenterId && volume?.idle === true
      && Number.isFinite(volume?.monthlyStorageUsd),
    'Verify the existing volume, ongoing price and idle status, then select Secure Cloud stock in its data center.');
  try {
    if (!fresh || !limits) throw new Error('Get a current quote including compute and running storage, and supply the approved spending and duration limits.');
    if (!provider.runningPrice || Math.abs(limits.quotedHourlyUsd -
        (provider.runningPrice.computeUsd + provider.runningPrice.storageUsd)) > 0.001) {
      throw new Error('Provide the current hourly compute and running storage amounts. Their sum must match the quoted hourly rate.');
    }
    checkQuote(limits);
    add('running_quote', true);
  } catch (error) {
    add('running_quote', false, error.message);
  }
  return { status: checks.every(check => check.status === 'ready') ? 'ready' : 'blocked', checks,
    evidence: 'Runpod observations are supplied by the coordinating client from live reads.',
    ...(identity ? { sshPublicKey: identity.publicKey, fingerprint: identity.fingerprint, identityFile: identity.identityFile, authentication: identity.authentication } : {}),
    ...(gpu ? { gpu } : {}), ...(volume ? { volume } : {}),
    ...(limits && fresh ? { quote: { checkedAt: provider.checkedAt, ...provider.runningPrice, ...limits } } : {}) };
}

export function launchStatus(events, { now, deadline, setupState, podId }) {
  const stage = events.at(-1)?.stage ?? 'planned';
  const leaseEnd = Date.parse(deadline);
  const sshStart = events.find(event => event.stage === 'allocating' || event.stage === 'allocated');
  const sshBy = sshStart ? Math.min(Date.parse(sshStart.at) + SSH_TIMEOUT_MS, leaseEnd) : leaseEnd;
  const ssh = events.find(event => event.stage === 'ssh_verified');
  const watchdog = events.find(event => event.stage === 'watchdog_armed');
  const timeoutAt = !ssh ? sshBy
    : !watchdog ? Math.min(Date.parse(ssh.at) + WATCHDOG_TIMEOUT_MS, leaseEnd) : leaseEnd;
  const stopped = events.some(event => event.stage === 'stopped');
  const timedOut = stage !== 'ready' && !stopped && setupState !== 'connected' && now >= timeoutAt;
  const stopRequired = !stopped && (setupState === 'failed' || timedOut);
  const finished = events.find(event => event.stage === 'ready' || event.stage === 'stopped');
  return {
    stage, podId, status: stopped ? 'stopped' : stopRequired ? 'stop_required' : stage === 'ready' ? 'ready' : 'in_progress',
    stageElapsedSeconds: finished || !events.length ? 0 : Math.max(0, (now - Date.parse(events.at(-1).at)) / 1000),
    elapsedSeconds: events.length ? Math.max(0, (Date.parse(finished?.at) || now) - Date.parse(events[0].at)) / 1000 : 0,
    timeoutAt: new Date(timeoutAt).toISOString(), events,
    ...(stopRequired ? { next: 'Record cloud_setup_failed. Verify ownership using the saved Pod ID or exact planned name through Runpod MCP, stop that Pod, verify EXITED or TERMINATED, then record stopped. Reconcile an ambiguous create before considering another allocation.' } : {}),
  };
}

export function estimateCloudVideo({ launch, sample, shotFrames, availableSeconds, setupSeconds, quotedHourlyUsd }) {
  const remainingSeconds = Math.max(0, Math.floor(availableSeconds));
  if (!sample) return { status: 'needs_measurement', remainingSeconds, shutdownReserveSeconds: 60,
    next: 'Render and retrieve a representative shot using the intended GPU and full video recipe. Use its job ID to estimate this batch.' };
  const comparable = shotFrames.every(frames => frames <= sample.frames);
  if (!comparable) return { status: 'needs_measurement', remainingSeconds, shutdownReserveSeconds: 60,
    next: 'Measure a representative shot as long as the longest planned shot.' };
  // Charge shorter shots at the measured shot's full duration. Reserve 25%
  // for variability, transfer overhead and repeated job setup.
  const workSeconds = Math.ceil(1.25 * shotFrames.length * (sample.renderSeconds + sample.retrievalSeconds));
  const requiredSeconds = setupSeconds === null ? null : Math.ceil(setupSeconds + workSeconds);
  return { status: requiredSeconds === null ? 'needs_setup_measurement' : requiredSeconds <= remainingSeconds ? 'fits_estimate' : 'over_budget',
    remainingSeconds, shutdownReserveSeconds: 60, startupSeconds: setupSeconds, launchStage: launch.stage,
    workSeconds, requiredSeconds, estimatedWorkUsd: Math.round(workSeconds * quotedHourlyUsd / 3600 * 10000) / 10000,
    estimatedRequiredUsd: requiredSeconds === null ? null : Math.round(requiredSeconds * quotedHourlyUsd / 3600 * 10000) / 10000,
    sample, shotCount: shotFrames.length, marginPercent: 25,
    note: 'Shorter shots use the sample’s full measured time. Render time includes LTX 2× spatial upscaling and refinement. Local Lanczos delivery runs outside the Pod lease.' };
}
