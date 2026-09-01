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

test('默认只安装普通扩展，不修改配置', async t => {
  const stRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-fake-st-'));
  await fs.mkdir(path.join(stRoot, 'public', 'scripts', 'extensions'), { recursive: true });
  await fs.writeFile(path.join(stRoot, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.18.0' }));
  await fs.writeFile(path.join(stRoot, 'config.yaml'), 'port: 8000\nenableServerPlugins: false\n');

  const install = path.join(projectRoot, 'scripts', 'install.mjs');
  const verify = path.join(projectRoot, 'scripts', 'verify-install.mjs');
  await execute(process.execPath, [install, '--st', stRoot]);
  const verification = await execute(process.execPath, [verify, '--st', stRoot]);

  await fs.stat(path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'st-image-atelier', 'index.js'));
  const config = await fs.readFile(path.join(stRoot, 'config.yaml'), 'utf8');
  assert.match(config, /enableServerPlugins: false/);
  const names = await fs.readdir(stRoot);
  assert.equal(names.some(name => name.startsWith('config.yaml.stia-backup-')), false);
  assert.match(verification.stdout, /免服务端安装自检通过/);

  t.after(() => fs.rm(stRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
});

test('增强模式显式安装 Server Plugin 并备份配置', async t => {
  const stRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stia-fake-st-server-'));
  await fs.mkdir(path.join(stRoot, 'public', 'scripts', 'extensions'), { recursive: true });
  await fs.writeFile(path.join(stRoot, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.14.0' }));
  await fs.writeFile(path.join(stRoot, 'config.yaml'), 'port: 8000\nenableServerPlugins: false\n');

  const install = path.join(projectRoot, 'scripts', 'install.mjs');
  const verify = path.join(projectRoot, 'scripts', 'verify-install.mjs');
  await execute(process.execPath, [
    install,
    '--st', stRoot,
    '--with-server-plugin',
    '--enable-server-plugins',
  ]);
  const verification = await execute(process.execPath, [verify, '--st', stRoot, '--with-server-plugin']);

  await fs.stat(path.join(stRoot, 'plugins', 'st-image-atelier', 'index.js'));
  assert.match(await fs.readFile(path.join(stRoot, 'config.yaml'), 'utf8'), /enableServerPlugins: true/);
  assert.ok((await fs.readdir(stRoot)).some(name => name.startsWith('config.yaml.stia-backup-')));
  assert.match(verification.stdout, /可选 Server Plugins 已启用/);

  t.after(() => fs.rm(stRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
});
