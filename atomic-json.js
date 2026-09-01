'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function atomicWriteJson(file, value, { backupFile } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (backupFile) {
    try {
      await fs.copyFile(file, backupFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const transientCodes = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      if (!transientCodes.has(error.code) || attempt >= 5) throw error;
      try {
        if (await fs.readFile(file, 'utf8') === serialized) return;
      } catch {
        // The destination may not exist yet; retry the atomic rename below.
      }
      await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
    }
  }
}

module.exports = { readJson, atomicWriteJson };
