import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertApproval, downloadMessage } from './approvals.mjs';
import { runpodLaunchWarning } from './runpod-notices.mjs';

async function signingKey(stateDir) {
  const directory = join(stateDir, 'cloud');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Cloud approval storage must be a private owned directory.');
  }
  const path = join(directory, 'download-approval-key.pem');
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const { privateKey } = generateKeyPairSync('ed25519');
    await handle.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await handle.sync();
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe cloud approval key.');
    const key = createPrivateKey(await handle.readFile());
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid cloud approval key.');
    return key;
  } finally { await handle.close(); }
}

export async function cloudApprovalPublicKey(stateDir) {
  return createPublicKey(await signingKey(stateDir)).export({ type: 'spki', format: 'pem' });
}

export function cloudDownloadManifest({ lease, models, installation }) {
  return { kind: 'model-download', runtime: `Runpod ${lease.runtimeId}`, destination: '/workspace/models',
    files: models.map(file => ({ path: file.path, repository: file.repo, revision: file.revision, size: file.size,
      sha256: file.sha256, source: `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.filename ?? file.path}`,
      destination: `/workspace/models/${file.path}` })),
    bundleId: lease.bundleId, expiresAt: lease.deadline, ...(lease.budget ? { budget: structuredClone(lease.budget) } : {}),
    ...(installation ? { installation } : {}),
    ...(lease.networkVolumeId ? { networkVolumeId: lease.networkVolumeId } : {}),
    ...(lease.containerDiskGb ? { containerDiskGb: lease.containerDiskGb } : {}) };
}

export async function approveCloudDownload(stateDir, gate, { lease, models, setup, signal, expiresAt, installation }) {
  const manifest = cloudDownloadManifest({ lease, models, installation });
  const budget = lease.budget;
  const message = installation ? [
    `Approve these model downloads on the running Runpod Pod ${installation.podId}?`,
    `The Pod continues billing at the quoted rate of $${budget.quotedHourlyUsd}/hour until stopped.`,
    `The existing session deadline stays ${lease.deadline}. This does not create a Pod or extend the lease.`,
    '', downloadMessage(manifest), '', ...manifest.files.map(file => file.source),
  ].join('\n') : budget ? [
    'Approve this Runpod session and its model downloads?',
    `Quoted rate: $${budget.quotedHourlyUsd}/hour; hourly limit: $${budget.maxHourlyUsd}.`,
    `Session budget: $${budget.maxTotalUsd}; maximum duration: ${budget.maxMinutes} minutes.`,
    `Session expires: ${lease.deadline}. Routine generation within this session needs no further spending approval.`,
    ...(lease.networkVolumeId ? [`Reuse models from Runpod Network Volume ${lease.networkVolumeId}. Only missing weights are downloaded. The volume continues billing after the Pod stops.`] : []),
    ...(lease.containerDiskGb ? [`Use a ${lease.containerDiskGb} GB temporary container disk for this session.`] : []),
    runpodLaunchWarning(lease),
    'Uploads of private prompts or media follow your separately chosen Runpod upload preference. Destructive cleanup requires separate approval.',
    '', downloadMessage(manifest),
  ].join('\n') : downloadMessage(manifest);
  const grant = await gate.require(manifest, message, { signal, expiresAt });
  assertApproval(grant, cloudDownloadManifest({ lease, models, installation }));
  const key = await signingKey(stateDir);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  if (setup.approvalPublicKey !== publicKey) throw new Error(installation
    ? 'This installation cannot confirm downloads with the original Pod’s approval key.'
    : 'The approval key changed. Prepare and approve a new cloud bundle.');
  const now = Date.now();
  if (now >= Date.parse(lease.deadline)) throw new Error('Cloud session expired while waiting for model download approval.');
  const body = { version: 1, purpose: installation ? 'model-install' : 'model-download', runtimeId: lease.runtimeId, bundleId: lease.bundleId,
    destination: '/workspace/models', models, issuedAt: new Date(now).toISOString(), expiresAt: lease.deadline,
    ...(installation ? { installation } : {}),
    ...(lease.networkVolumeId ? { networkVolumeId: lease.networkVolumeId } : {}),
    ...(lease.containerDiskGb ? { containerDiskGb: lease.containerDiskGb } : {}) };
  const payload = Buffer.from(JSON.stringify(body));
  return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
}
