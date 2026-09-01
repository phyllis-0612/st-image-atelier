#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const stIndex = args.indexOf('--st');
const stRoot = stIndex >= 0 ? path.resolve(args[stIndex + 1] || '') : '';
const purgeData = args.includes('--purge-data');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) {
    throw new Error(`拒绝删除目录边界外路径：${candidate}`);
  }
  return candidate;
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

async function main() {
  if (!stRoot || !await exists(path.join(stRoot, 'package.json'))) {
    throw new Error('请传有效的 --st /path/to/SillyTavern');
  }
  const targets = [
    inside(stRoot, path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'st-image-atelier')),
    inside(stRoot, path.join(stRoot, 'plugins', 'st-image-atelier')),
  ];
  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    console.log(`已移除：${target}`);
  }
  if (purgeData) {
    const dataRoot = inside(stRoot, path.join(stRoot, 'data'));
    if (await exists(dataRoot)) {
      const users = await fs.readdir(dataRoot, { withFileTypes: true });
      for (const user of users.filter(entry => entry.isDirectory())) {
        const target = inside(dataRoot, path.join(dataRoot, user.name, 'st-image-atelier'));
        await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        console.log(`已永久删除用户数据：${target}`);
      }
    }
  } else {
    console.log('用户配置和图片已保留。需要永久删除时显式传 --purge-data。');
  }
}

main().catch(error => {
  console.error(`卸载失败：${error.message}`);
  process.exitCode = 1;
});
