#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readConfig, saveConfig } from './src/config.mjs';

const help = `Happy Latent Agent
  setup --client codex|claude|none [--managed] [--comfy-root PATH] [--comfy-url URL] [--workspace PATH] [--verify] [--test-generation]
  doctor
  verify [--generate] [--timeout SECONDS] [--request-id ID]
  start | stop | status
  auth [--force | --forget]
  models [--media video|image|music|speech] [--download] [--comfy-root PATH]
         [--spatial-upscale] [--temporal-upscale] [--speech-model-dir PATH]
  speech-setup --speech-model-dir PATH [--speech-python PATH] [--speech-device auto|mps|cuda|cpu]
  cloud-setup --client codex|claude|none [--workspace PATH]
  cloud-status
  serve

Use --state-dir PATH to select a separate configuration and local state folder.
Log in with hf auth login in your own terminal; choose Paste an access token with general read or fine-grained model-read access.
The auth command only checks the saved HF CLI credential. Use hf auth login --force to replace a login.
Review Hugging Face repository links, filenames, GB per file, total GB and destination before approving model downloads.
Credentials use the shared HF CLI cache. Use hf auth logout to log out of HF tools.
auth --forget removes only legacy Happy Latent credentials; provider revocation is separate.`;

async function main() {
  const [operation = 'setup', ...args] = process.argv.slice(2);
  if (['-h', '--help', 'help'].includes(operation) || args.includes('--help')) {
    console.log(help);
    return;
  }
  const common = { 'state-dir': { type: 'string' } };
  const connection = { 'comfy-url': { type: 'string' }, 'comfy-root': { type: 'string' } };
  const schemas = {
    setup: {
      ...connection, workspace: { type: 'string' }, managed: { type: 'boolean' },
      client: { type: 'string', default: 'none' },
      'no-browser': { type: 'boolean' }, // Compatibility with existing installer commands.
      verify: { type: 'boolean' }, 'test-generation': { type: 'boolean' },
    },
    auth: { force: { type: 'boolean' }, forget: { type: 'boolean' } },
    models: { ...connection, download: { type: 'boolean' }, media: { type: 'string', default: 'video' },
      'spatial-upscale': { type: 'boolean' }, 'temporal-upscale': { type: 'boolean' }, 'speech-model-dir': { type: 'string' } },
    'speech-setup': {
      'speech-model-dir': { type: 'string' },
      'speech-python': { type: 'string' },
      'speech-device': { type: 'string' },
    },
    'cloud-setup': { client: { type: 'string', default: 'none' }, workspace: { type: 'string' } },
    'cloud-status': {},
    doctor: {},
    verify: { generate: { type: 'boolean' }, timeout: { type: 'string' }, 'request-id': { type: 'string' } },
    start: {}, stop: {}, status: {},
    serve: { 'comfy-url': connection['comfy-url'], workspace: { type: 'string' }, 'local-only': { type: 'boolean' } },
  };
  if (!Object.hasOwn(schemas, operation)) throw new Error(`Unknown command ${operation}. Use --help.`);
  const { values } = parseArgs({ args, options: { ...common, ...schemas[operation] } });
  const config = await readConfig(values);
  if (values['local-only']) config.localOnly = true;
  if (operation === 'serve') {
    // Strip credentials still supplied by older client configurations.
    delete process.env.RUNPOD_API_KEY;
    await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
    const { startMcp } = await import('./src/server.mjs');
    await startMcp(config);
  } else if (operation === 'doctor' || operation === 'verify') {
    const { doctor, verifyInstallation } = await import('./src/verify.mjs');
    const seconds = values.timeout === undefined ? 900 : Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
      throw new Error('Use --timeout with seconds from 1 to 86400.');
    }
    const result = operation === 'doctor' ? await doctor(config) : await verifyInstallation(config, {
      generate: Boolean(values.generate), timeoutMs: seconds * 1000,
      ...(values['request-id'] === undefined ? {} : { requestId: values['request-id'] }),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (['start', 'stop', 'status'].includes(operation)) {
    const { ManagedRuntime } = await import('./src/runtime.mjs');
    const result = await new ManagedRuntime(config)[operation]();
    console.log(JSON.stringify(result, null, 2));
  } else if (operation === 'cloud-setup') {
    if (!['codex', 'claude', 'none'].includes(values.client)) throw new Error('Use --client codex, claude, or none.');
    await saveConfig(config);
    await mkdir(config.workspaceDir, { recursive: true, mode: 0o700 });
    const { registerClient } = await import('./src/register.mjs');
    await registerClient(values.client, config);
    console.log(JSON.stringify({ status: 'registered', client: values.client, workspaceDir: config.workspaceDir,
      next: 'Connect and sign in to Runpod MCP in your client. Choose a dedicated SSH key, unlock it in your terminal, and add only its public key in Runpod Account Settings. The agent can then check your setup and guide deployment.' }, null, 2));
  } else if (operation === 'cloud-status') {
    const { Cloud } = await import('./src/cloud.mjs');
    console.log(JSON.stringify(await new Cloud(config).status(), null, 2));
  } else if (operation === 'auth') {
    if (values.force && values.forget) throw new Error('Choose --force or --forget, not both.');
    const { runAuth, forgetAuth } = await import('./src/hf-auth.mjs');
    if (values.forget) {
      const result = await forgetAuth({ stateDir: config.stateDir });
      console.log(JSON.stringify({ ...result, message: 'Legacy Happy Latent credentials removed; shared HF CLI credentials are unchanged. Use hf auth logout to remove HF CLI credentials, and Hugging Face settings to revoke tokens.' }, null, 2));
    } else await runAuth({ stateDir: config.stateDir, force: values.force });
  } else if (operation === 'models') {
    const { runModels, LOCAL_MODEL_MEDIA } = await import('./src/setup.mjs');
    if (!LOCAL_MODEL_MEDIA.includes(values.media)) throw new Error('Use --media video, image, music, or speech.');
    const enhancements = values['spatial-upscale'] || values['temporal-upscale'] ? {
      spatialUpscale: Boolean(values['spatial-upscale']), temporalUpscale: Boolean(values['temporal-upscale']),
    } : undefined;
    if (enhancements && values.media !== 'video') throw new Error('Upscaler flags apply to video model downloads only.');
    const { ManagedRuntime } = await import('./src/runtime.mjs');
    const runtime = new ManagedRuntime(config);
    try {
      if (values.media !== 'speech') await runtime.ensure();
      const plan = await runModels({ ...config, download: values.download, media: values.media, enhancements });
      if (plan) console.log(JSON.stringify(plan, null, 2));
    } finally { await runtime.close(); }
  } else if (operation === 'speech-setup') {
    const { Speech } = await import('./src/speech.mjs');
    const result = await new Speech(config).checkSetup();
    if (result.status === 'ready') await saveConfig(config);
    else process.exitCode = 1;
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!['codex', 'claude', 'none'].includes(values.client)) throw new Error('Use --client codex, claude, or none.');
    const { runSetup } = await import('./src/setup.mjs');
    const result = await runSetup({
      ...config, managed: values.managed ?? (values['comfy-root'] === undefined && values['comfy-url'] === undefined ? config.runtime?.managed : false),
      autoManaged: !config.configured && values['comfy-root'] === undefined && values['comfy-url'] === undefined,
      nodeRoot: process.env.HAPPYLATENT_NODE_ROOT,
      comfyRootExplicit: values['comfy-root'] !== undefined,
      comfyUrlExplicit: values['comfy-url'] !== undefined,
    });
    const saved = { ...config };
    if (result.comfyUrl) saved.comfyUrl = result.comfyUrl;
    if (result.comfyRoot) saved.comfyRoot = result.comfyRoot;
    saved.runtime = result.runtime;
    await saveConfig(saved);
    await mkdir(saved.workspaceDir, { recursive: true, mode: 0o700 });
    const { registerClient } = await import('./src/register.mjs');
    await registerClient(values.client, saved);
    let verification;
    if (values.verify || values['test-generation']) {
      const { verifyInstallation } = await import('./src/verify.mjs');
      verification = await verifyInstallation(saved, { generate: Boolean(values['test-generation']) });
      if (!verification.ok) process.exitCode = 1;
    }
    console.log(JSON.stringify({ ...result, workspaceDir: saved.workspaceDir, client: values.client,
      ...(verification ? { verification } : {}),
      next: result.ready ? 'Open a new client session, then ask Happy Latent to generate a video. Use verify --generate for a real test render.' :
        'Open a new client session and ask Happy Latent to check model access and help download the missing video models.' }, null, 2));
  }
}

main().catch((error) => {
  console.error(`Happy Latent: ${error.message}`);
  process.exitCode = 1;
});
