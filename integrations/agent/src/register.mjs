import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const name = 'happylatent';

function command(binary, args) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Install the ${binary} CLI or use --client none.`, { cause: error });
    throw error;
  }
}

function missingServer(error) {
  return error.status === 1 && /No MCP server (?:named|found with name)\b/i.test(String(error.stderr || error.stdout));
}

function matches(actual, expected) {
  return actual && (actual.type === undefined || actual.type === 'stdio') &&
    actual.command === expected.command && Array.isArray(actual.args) &&
    actual.args.length === expected.args.length &&
    actual.args.every((arg, index) => arg === expected.args[index]);
}

async function readRegistration(client) {
  if (client === 'codex') {
    try {
      const record = JSON.parse(command('codex', ['mcp', 'get', name, '--json']));
      if (record.name !== name || !record.transport) throw new Error('Unexpected codex mcp get JSON response.');
      return { entry: record.transport, enabled: record.enabled !== false && !record.disabled_reason };
    } catch (error) {
      if (missingServer(error)) return undefined;
      throw error;
    }
  }

  // Claude's get command is human-readable. Inspect the user entry as structured
  // JSON to preserve argument boundaries, then confirm that user scope is active.
  // Never rewrite this file: the native CLI remains responsible for mutations.
  const configPath = process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
  let entry;
  try {
    entry = JSON.parse(await readFile(configPath, 'utf8')).mcpServers?.[name];
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read Claude's user MCP configuration at ${configPath}.`, { cause: error });
  }
  let output;
  try {
    output = command('claude', ['mcp', 'get', name]);
  } catch (error) {
    if (missingServer(error) && !entry) return undefined;
    throw error;
  }
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (!entry || !/^\s*Scope:\s*User\b/im.test(plain)) {
    throw new Error('Happy Latent is registered outside Claude user scope or is shadowed by another configuration. Review claude mcp get happylatent.');
  }
  return { entry, enabled: !/Disabled for this project|Rejected|Blocked by enterprise|Pending approval/i.test(plain) };
}

export async function registerClient(client, config) {
  if (!['codex', 'claude', 'none'].includes(client)) throw new Error('Use --client codex, claude, or none.');
  if (client === 'none') return;
  const args = [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'serve', '--state-dir', config.stateDir];
  const expected = { type: 'stdio', command: process.execPath, args };
  const before = await readRegistration(client);
  if (before && !matches(before.entry, expected)) {
    throw new Error(`A different Happy Latent MCP is registered in ${client}. Kept it unchanged. Review ${client} mcp get happylatent before replacing it.`);
  }
  if (before && !before.enabled) {
    throw new Error(`The existing Happy Latent MCP is disabled or blocked in ${client}. Enable it in the client before verifying setup.`);
  }
  if (!before) {
    if (client === 'codex') {
      command('codex', ['mcp', 'add', name, '--', expected.command, ...args]);
    } else {
      command('claude', ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify(expected)]);
    }
  }
  const after = await readRegistration(client);
  if (!after?.enabled || !matches(after.entry, expected)) {
    throw new Error(`Could not verify the Happy Latent MCP registration in ${client}. Inspect ${client} mcp get happylatent; the client did not return the expected configuration.`);
  }

  return { client, name, status: before ? 'existing' : 'registered', verified: true };
}
