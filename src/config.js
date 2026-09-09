// Node-only: where the CLI keeps the OpenRouter key and preferences. 0600 file in the user's config dir.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function configDir() {
  if (process.env.LLMSCOPE_CONFIG_DIR) return process.env.LLMSCOPE_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'llmscope');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

export async function loadConfig() {
  try { return JSON.parse(await fs.readFile(configPath(), 'utf8')); } catch { return {}; }
}

export async function saveConfig(cfg) {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(configPath(), 0o600);
  return configPath();
}

export async function updateConfig(patch) {
  const cfg = await loadConfig();
  for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === null) delete cfg[k]; else cfg[k] = v; }
  return saveConfig(cfg);
}

/** Precedence: explicit flag > OPENROUTER_API_KEY env > config file. */
export async function resolveApiKey({ flag } = {}) {
  if (flag) return { key: flag, source: 'flag' };
  if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, source: 'env' };
  const cfg = await loadConfig();
  if (cfg.openrouter_api_key) return { key: cfg.openrouter_api_key, source: 'config' };
  return { key: null, source: null };
}

export function maskKey(key) {
  if (!key) return '';
  return key.length > 14 ? `${key.slice(0, 10)}…${key.slice(-4)}` : '••••';
}
