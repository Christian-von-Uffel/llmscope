import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmscope-cfg-'));
process.env.LLMSCOPE_CONFIG_DIR = dir;
delete process.env.OPENROUTER_API_KEY;
const { saveConfig, loadConfig, updateConfig, resolveApiKey, configPath } = await import('../src/config.js');

test('config round-trips with 0600 permissions', async () => {
  await saveConfig({ openrouter_api_key: 'sk-or-v1-abcdefghijklmnop' });
  assert.equal(configPath(), path.join(dir, 'config.json'));
  const mode = (await fs.stat(configPath())).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await loadConfig()).openrouter_api_key, 'sk-or-v1-abcdefghijklmnop');
});

test('key precedence: flag > env > config; clear removes', async () => {
  assert.deepEqual(await resolveApiKey({}), { key: 'sk-or-v1-abcdefghijklmnop', source: 'config' });
  process.env.OPENROUTER_API_KEY = 'sk-or-env';
  assert.equal((await resolveApiKey({})).source, 'env');
  assert.equal((await resolveApiKey({ flag: 'sk-or-flag' })).source, 'flag');
  delete process.env.OPENROUTER_API_KEY;
  await updateConfig({ openrouter_api_key: null });
  assert.equal((await resolveApiKey({})).key, null);
});
