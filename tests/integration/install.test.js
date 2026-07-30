import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('安装脚本验证版本、复制双端并备份配置', async t => {
  const stRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-fake-st-'));
  await fs.mkdir(path.join(stRoot, 'public', 'scripts', 'extensions'), { recursive: true });
  await fs.writeFile(path.join(stRoot, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  await fs.writeFile(path.join(stRoot, 'config.yaml'), 'port: 8000\nenableServerPlugins: false\n');

  const install = path.join(projectRoot, 'scripts', 'install.mjs');
  const verify = path.join(projectRoot, 'scripts', 'verify-install.mjs');
  await execute(process.execPath, [install, '--st', stRoot, '--enable-server-plugins']);
  const verification = await execute(process.execPath, [verify, '--st', stRoot]);

  await fs.stat(path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'st-image-atelier', 'index.js'));
  await fs.stat(path.join(stRoot, 'plugins', 'st-image-atelier', 'index.js'));
  const config = await fs.readFile(path.join(stRoot, 'config.yaml'), 'utf8');
  assert.match(config, /enableServerPlugins: true/);
  const names = await fs.readdir(stRoot);
  assert.ok(names.some(name => name.startsWith('config.yaml.stia-backup-')));
  assert.match(verification.stdout, /安装自检通过/);

  t.after(() => fs.rm(stRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
});
