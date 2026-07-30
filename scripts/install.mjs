#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argumentsOf(argv) {
  const result = { force: false, enableServerPlugins: false, withServerPlugin: false, st: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--force') result.force = true;
    else if (value === '--enable-server-plugins') result.enableServerPlugins = true;
    else if (value === '--with-server-plugin') result.withServerPlugin = true;
    else if (value === '--st') result.st = argv[++index] || '';
    else if (!value.startsWith('-') && !result.st) result.st = value;
  }
  return result;
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

async function findSillyTavern(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [];
  let current = process.cwd();
  for (let count = 0; count < 5; count += 1) {
    candidates.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (process.env.SILLY_TAVERN_HOME) candidates.unshift(path.resolve(process.env.SILLY_TAVERN_HOME));
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'public', 'scripts', 'extensions'))
      && await exists(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('无法自动定位 SillyTavern。请传 --st /path/to/SillyTavern');
}

async function validate(root) {
  const packageFile = path.join(root, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  const version = String(packageJson.version || '');
  const match = /^1\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) < 14 || Number(match[1]) > 18) {
    throw new Error(`不支持的 SillyTavern 版本：${version || '未知'}；需要 1.14.x–1.18.x`);
  }
  if (!await exists(path.join(root, 'public', 'scripts', 'extensions'))) {
    throw new Error('目标目录不是有效的 SillyTavern：缺少 public/scripts/extensions');
  }
  return version;
}

async function copyDirectory(source, target, force) {
  if (await exists(target)) {
    if (!force) throw new Error(`目标已存在：${target}\n升级时请先备份并传 --force`);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  const staging = `${target}.stia-install-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await fs.cp(source, staging, { recursive: true });
  await fs.rename(staging, target);
}

async function installUi(target, force) {
  const staging = path.join(sourceRoot, '.install-ui-staging');
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  for (const file of ['manifest.json', 'index.js', 'style.css']) {
    await fs.copyFile(path.join(sourceRoot, file), path.join(staging, file));
  }
  await fs.cp(path.join(sourceRoot, 'src'), path.join(staging, 'src'), { recursive: true });
  try {
    await copyDirectory(staging, target, force);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function inspectConfig(root, enable) {
  const config = path.join(root, 'config.yaml');
  if (!await exists(config)) return { enabled: false, message: '未找到 config.yaml，请手动确认 enableServerPlugins' };
  const content = await fs.readFile(config, 'utf8');
  const enabled = /^enableServerPlugins:\s*true\s*$/mi.test(content);
  if (enabled || !enable) {
    return {
      enabled,
      message: enabled
        ? 'Server Plugins 已启用'
        : 'Server Plugins 尚未启用；将 config.yaml 的 enableServerPlugins 改为 true 后重启',
    };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${config}.stia-backup-${stamp}`;
  await fs.copyFile(config, backup);
  const next = /^enableServerPlugins:\s*.*$/mi.test(content)
    ? content.replace(/^enableServerPlugins:\s*.*$/mi, 'enableServerPlugins: true')
    : `${content.trimEnd()}\nenableServerPlugins: true\n`;
  await fs.writeFile(config, next, 'utf8');
  return { enabled: true, message: `已启用 Server Plugins；配置备份：${backup}` };
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const stRoot = await findSillyTavern(options.st);
  const version = await validate(stRoot);
  const uiTarget = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'st-image-atelier');
  await fs.mkdir(path.dirname(uiTarget), { recursive: true });
  await installUi(uiTarget, options.force);
  console.log(`Image Atelier 已安装到 SillyTavern ${version}`);
  console.log(`UI: ${uiTarget}`);
  console.log('运行模式：免服务端直连（默认，无需修改 config.yaml）');
  if (options.withServerPlugin) {
    const pluginTarget = path.join(stRoot, 'plugins', 'st-image-atelier');
    await fs.mkdir(path.dirname(pluginTarget), { recursive: true });
    await copyDirectory(path.join(sourceRoot, 'server-plugin'), pluginTarget, options.force);
    const config = await inspectConfig(stRoot, options.enableServerPlugins);
    console.log(`可选 Server Plugin: ${pluginTarget}`);
    console.log(config.message);
  }
  console.log(`重启：cd "${stRoot}" && npm start`);
}

main().catch(error => {
  console.error(`安装失败：${error.message}`);
  process.exitCode = 1;
});
