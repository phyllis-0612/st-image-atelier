#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const self = args.includes('--self');
const withServerPlugin = args.includes('--with-server-plugin');
const stIndex = args.indexOf('--st');
const stRoot = stIndex >= 0 ? path.resolve(args[stIndex + 1] || '') : '';

async function must(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
}

async function verifySource(root, includeServer = false) {
  const files = [
    'manifest.json',
    'index.js',
    'style.css',
    'src/ui/parser/draw-parser.js',
    'src/ui/compat/st-api.js',
    'src/ui/media/image-viewer.js',
  ];
  if (includeServer) {
    files.push(
      'server-plugin/index.js',
      'server-plugin/src/routes/index.js',
      'server-plugin/src/services/generation.js',
      'server-plugin/src/services/storage.js',
    );
  }
  await Promise.all(files.map(file => must(path.join(root, file))));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.display_name !== 'Image Atelier' || manifest.minimum_client_version !== '1.14.0') {
    throw new Error('manifest 内容不正确');
  }
  return files.length;
}

async function main() {
  if (self) {
    const count = await verifySource(projectRoot, true);
    console.log(`源码自检通过：${count} 个关键文件`);
    return;
  }
  if (!stRoot) throw new Error('请传 --st /path/to/SillyTavern，或用 --self 检查源码');
  const ui = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'st-image-atelier');
  const count = await verifySource(ui);
  console.log(`免服务端安装自检通过：${count} 个关键文件`);
  if (withServerPlugin) {
    const plugin = path.join(stRoot, 'plugins', 'st-image-atelier');
    await must(path.join(plugin, 'index.js'));
    await must(path.join(plugin, 'src', 'routes', 'index.js'));
    const config = await fs.readFile(path.join(stRoot, 'config.yaml'), 'utf8').catch(() => '');
    const enabled = /^enableServerPlugins:\s*true\s*$/mi.test(config);
    console.log(enabled ? '可选 Server Plugins 已启用' : '警告：可选 Server Plugins 未启用');
    if (!enabled) process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(`验证失败：${error.message}`);
  process.exitCode = 1;
});
