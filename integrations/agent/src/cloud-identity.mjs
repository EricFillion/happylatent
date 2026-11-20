import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { identityPublicKey, localAgentSocket, normalizeHostKey, validateIdentityFile } from './cloud-ssh.mjs';

const execute = promisify(execFile);

/** Inspect a USER-CREATED key. Never generate, unlock, copy or register keys. */
export async function checkCloudIdentity({ identityFile, authentication = 'agent' }, { executeImpl = execute, env = process.env } = {}) {
  if (!['agent', 'file'].includes(authentication)) throw new Error('SSH authentication must be agent or file.');
  await validateIdentityFile(identityFile);
  const { publicKeyFile, publicKey } = await identityPublicKey(identityFile);
  const childEnv = { PATH: '/usr/bin:/bin', SSH_ASKPASS_REQUIRE: 'never' };
  if (authentication === 'agent') {
    childEnv.SSH_AUTH_SOCK = await localAgentSocket(env);
    try {
      // This tests signing with ONLY the selected key; do not enumerate every
      // personal key or return any private material in MCP results/errors.
      await executeImpl('/usr/bin/ssh-add', ['-T', publicKeyFile], { env: childEnv, timeout: 15000, maxBuffer: 16384 });
    } catch {
      throw new Error('The local SSH agent could not use the selected key. Run ssh-add for this key in your own terminal and complete any unlock prompt, then retry cloud_ssh_check. Never enter the passphrase in chat.');
    }
  } else {
    let derived;
    try {
      derived = await executeImpl('/usr/bin/ssh-keygen', ['-y', '-P', '', '-f', identityFile], { env: childEnv, timeout: 15000, maxBuffer: 16384 });
    } catch {
      throw new Error('File authentication requires a readable key without a passphrase. For a protected key, unlock it yourself with ssh-add and use authentication: agent. Do not remove its passphrase for Happy Latent.');
    }
    if (normalizeHostKey(derived.stdout.trim()) !== publicKey) throw new Error('The SSH private key and .pub file do not match. Select the original matching pair.');
  }
  const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(publicKey.split(' ')[1], 'base64')).digest('base64').replace(/=+$/, '');
  return { status: 'ready', identityFile, authentication, publicKey, fingerprint,
    keyCreated: false, providerKeyRegistered: false,
    next: 'Match this public key against Runpod account public-key metadata before spending. If missing, guide the user to add it manually in Runpod Account Settings → SSH Public Keys. Do not ask them to add it again if it already matches. This local check does not verify Runpod registration or a remote connection.' };
}
