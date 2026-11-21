import { randomUUID } from 'node:crypto';
import { downloadManifest, downloadMessage, fingerprint, assertApproval } from './approvals.mjs';
import { cloudSelectionPath, readOptional } from './cloud-state.mjs';
import { prepareModelDownload, checkModelAccess, executeModelDownload, LOCAL_MODEL_MEDIA } from './setup.mjs';
import { selectSpeechVoices } from './speech-models.mjs';
import { normalizeEnhancements } from './enhancements.mjs';
import { ManagedRuntime } from './runtime.mjs';

const steps = {
  needs_comfy_root: 'Set the ComfyUI folder with setup --comfy-root before downloading.',
  needs_token: 'Run hf auth login in your own terminal and choose Paste an access token with model-read access, then retry.',
  needs_access: 'Accept any gated model terms and obtain access on Hugging Face with the same account, then retry.',
  ready_to_download: 'Call download_models for the missing files and share its local approval link if review is required.',
};

export class ModelDownloads {
  constructor(config, gate, services = {}) {
    this.config = config; this.gate = gate; this.jobs = new Map(); this.requests = new Map();
    this.runtime = services.runtime ?? new ManagedRuntime(config);
    this.prepare = services.prepare ?? prepareModelDownload;
    this.check = services.check ?? checkModelAccess;
    this.execute = services.execute ?? executeModelDownload;
    this.queue = Promise.resolve(); this.closed = false;
  }
  async requireLocal(media, enhancements, voices) {
    if (!LOCAL_MODEL_MEDIA.includes(media)) throw new Error('Local model downloads support video, image, music, or speech.');
    if (enhancements && media !== 'video') throw new Error('Enhancements apply to video model downloads only.');
    if (voices !== undefined && media !== 'speech') throw new Error('Voice selection applies to speech model downloads only.');
    if (media === 'speech') return; // Kokoro always runs locally, including for Runpod projects.
    const selected = await readOptional(cloudSelectionPath(this.config));
    if (selected?.planId) throw new Error('A cloud runtime is selected. Use cloud_plan for cloud model downloads or explicitly switch to local.');
  }
  async preview({ media = 'video', enhancements, voices }, signal) {
    if (this.closed || signal?.aborted) throw new Error('Model access check was cancelled.');
    await this.requireLocal(media, enhancements, voices);
    if (media !== 'speech') await this.runtime.ensure();
    const options = { ...this.config, media, enhancements, voices };
    const plan = await this.prepare(options);
    const status = !plan.files.length ? 'ready' : !plan.modelDirectory ? 'needs_comfy_root' : await this.check(options, plan);
    if (this.closed || signal?.aborted) throw new Error('Model access check was cancelled.');
    return { status, plan, ...(steps[status] ? { next: steps[status] } : {}) };
  }
  start(input, signal) {
    const task = this.queue.then(() => this.begin(input, signal));
    this.queue = task.catch(() => {}); return task;
  }
  async begin({ requestId, media = 'video', enhancements, voices }, signal) {
    if (this.closed || signal?.aborted) throw new Error('Download request was cancelled.');
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new Error('Supply a stable download requestId.');
    await this.requireLocal(media, enhancements, voices);
    const videoOptions = media === 'video' ? normalizeEnhancements(enhancements) : undefined;
    const speakers = media === 'speech' ? selectSpeechVoices(voices) : undefined;
    const selection = fingerprint({ media, ...(videoOptions ? { videoOptions } : {}), ...(speakers ? { speakers } : {}) });
    const prior = this.requests.get(requestId);
    if (prior && prior.selection !== selection) throw new Error('This requestId belongs to another download selection. Use a new requestId.');
    if (prior && ['downloading', 'completed'].includes(prior.status)) return this.status({ downloadId: prior.id });
    if (media !== 'speech') await this.runtime.ensure();
    const options = { ...this.config, media, enhancements, voices };
    const currentPlan = await this.prepare(options);
    if (!currentPlan.files.length) return { status: 'ready', downloaded: false, plan: currentPlan };
    if (!currentPlan.modelDirectory) throw new Error(steps.needs_comfy_root);
    // A retry may have completed part of the approved batch. Never silently
    // expand it or use the same request id for a different source/destination.
    let plan = currentPlan;
    if (prior) {
      const old = downloadManifest(prior.plan);
      const next = downloadManifest(currentPlan);
      if (old.destination !== next.destination || next.files.some(file => !old.files.some(approved => fingerprint(file) === fingerprint(approved)))) {
        throw new Error('This requestId belongs to another download plan. Review the changed files with a new requestId.');
      }
      plan = prior.plan;
    }
    const phase = await this.check(options, plan);
    if (phase !== 'ready_to_download') throw new Error(steps[phase] ?? 'Check Hugging Face model access with check_model_access, then retry.');
    const manifest = downloadManifest(plan);
    const approval = await this.gate.require(manifest, downloadMessage(manifest), {
      signal, allowSmallDownload: media === 'video' || media === 'music',
    });
    // Check again after a potentially long human interaction, before starting.
    const latest = await this.prepare(options);
    const latestManifest = downloadManifest(latest);
    if (latestManifest.destination !== manifest.destination || latestManifest.files.some(file => !manifest.files.some(approved => fingerprint(file) === fingerprint(approved)))) {
      throw new Error('The model plan changed while waiting for approval. Review the new plan before downloading.');
    }
    assertApproval(approval, manifest);
    if (signal?.aborted || this.closed) throw new Error('Download request was cancelled.');
    const job = prior ?? { id: randomUUID(), requestId, media, selection, plan };
    job.status = 'downloading'; job.error = undefined; job.controller = new AbortController();
    this.jobs.set(job.id, job); this.requests.set(requestId, job);
    job.work = Promise.resolve().then(() => this.execute(options, plan, {
      approval, signal: job.controller.signal, onProgress: value => { job.progress = value; },
    })).then(result => { job.status = 'completed'; job.result = result; }, () => {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.status === 'cancelled' ? 'Download cancelled; verified files and resumable partials remain.' : 'Download failed. Check access, disk space and connection, then retry this requestId to resume the approved batch.';
    });
    return this.status({ downloadId: job.id });
  }
  status({ downloadId }) {
    const job = this.jobs.get(downloadId);
    if (!job) throw new Error('No download with that ID exists in this MCP session.');
    return { downloadId: job.id, requestId: job.requestId, media: job.media, status: job.status, plan: job.plan,
      ...(job.progress ? { progress: job.progress } : {}), ...(job.error ? { error: job.error } : {}),
      ...(job.result ? { result: job.result } : {}) };
  }
  cancel({ downloadId }) {
    const job = this.jobs.get(downloadId);
    if (!job) throw new Error('No download with that ID exists in this MCP session.');
    if (job.status === 'downloading') job.controller.abort();
    return { ...this.status({ downloadId }), cancellationRequested: job.status === 'downloading' };
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller?.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.work));
    await this.runtime.close();
  }
}
