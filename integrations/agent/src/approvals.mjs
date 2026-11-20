import { createHash } from 'node:crypto';

const grants = new WeakMap();
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Approval plans must contain only JSON values.');
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');

export class ApprovalRequired extends Error {
  constructor(message = 'This client cannot display the required confirmation. Use an MCP client that supports confirmation to approve this action in chat.') {
    super(message); this.name = 'ApprovalRequired'; this.code = 'APPROVAL_REQUIRED';
  }
}

// Grants never appear in tool arguments or results. The callback belongs to the
// trusted client/UI adapter, not to an LLM-supplied "approved" argument.
export class ApprovalGate {
  constructor(request, { now = Date.now, lifetimeMs = 4 * 60 * 60_000 } = {}) {
    this.request = request; this.now = now; this.lifetimeMs = lifetimeMs;
    this.accepted = new Map(); this.pending = new Map(); this.closed = false;
  }
  async require(manifest, message, { signal, reuse = true, allowSmallDownload = false, timeoutMs, expiresAt } = {}) {
    if (this.closed || signal?.aborted) throw new Error('Approval request was cancelled.');
    const frozen = JSON.parse(canonical(manifest));
    const digest = fingerprint(frozen);
    const previous = this.accepted.get(digest);
    if (reuse && previous && grants.get(previous)?.expiresAt > this.now()) return previous;
    if (this.pending.has(digest)) return this.pending.get(digest);
    const pending = (async () => {
      // Only explicit local model-download calls may use this narrow automatic policy.
      const automatic = allowSmallDownload && frozen.kind === 'model-download' && frozen.runtime === 'local'
        && Array.isArray(frozen.files) && frozen.files.length > 0
        && frozen.files.every(file => Number.isSafeInteger(file.size) && file.size >= 0)
        && frozen.files.reduce((total, file) => total + file.size, 0) < 1_000_000_000;
      if (!automatic && !this.request) throw new ApprovalRequired();
      const response = automatic ? { action: 'accept' } : await this.request({ manifest: frozen, digest, message, signal, timeoutMs, expiresAt });
      if (this.closed || signal?.aborted || response?.action !== 'accept') {
        throw new Error('Approval was not granted. Nothing was started.');
      }
      const grant = Object.freeze({});
      grants.set(grant, { digest, expiresAt: this.now() + this.lifetimeMs, now: this.now, gate: this });
      this.accepted.set(digest, grant);
      return grant;
    })();
    this.pending.set(digest, pending);
    try { return await pending; } finally { this.pending.delete(digest); }
  }
  close() { this.closed = true; this.accepted.clear(); }
}

export function assertApproval(grant, manifest) {
  const record = grants.get(grant);
  if (!record || record.gate.closed || record.expiresAt <= record.now() || record.digest !== fingerprint(manifest)) {
    throw new ApprovalRequired('The approval is missing, expired or belongs to a different plan. Review and approve the current plan.');
  }
}

export function downloadManifest(plan, runtime = 'local') {
  return {
    kind: 'model-download', runtime, destination: plan.modelDirectory,
    files: plan.files.map(file => ({ path: file.path, source: file.source,
      repository: file.repo ?? plan.modelRepository, revision: file.revision ?? plan.revision,
      size: file.size, sha256: file.sha256, destination: file.destination })),
  };
}

export function downloadMessage(manifest) {
  const lines = ['Download these model files from Hugging Face?', ''];
  const repos = [...new Set(manifest.files.map(file => file.repository))];
  for (const repo of repos) lines.push(`Repository: ${repo} — https://huggingface.co/${repo}`);
  lines.push('');
  for (const file of manifest.files) {
    lines.push(`${file.path} — ${(file.size / 1e9).toFixed(2)} GB${repos.length > 1 ? ` — ${file.repository}` : ''}`);
  }
  lines.push('', `Total: ${(manifest.files.reduce((sum, file) => sum + file.size, 0) / 1e9).toFixed(2)} GB`,
    `Destination: ${manifest.destination}`, `Runtime: ${manifest.runtime}`,
    '', 'One approval covers only these files, sources and destination, including resuming this batch.');
  return lines.join('\n');
}
