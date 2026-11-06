'use strict';

/**
 * Состояние установленных сборок: что скачано, есть ли обновление,
 * логотип для интерфейса и удаление.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const { instanceDir, instancesDir, minecraftDir, cacheDir } = require('./paths');
const { readState } = require('./sync');

// FancyMenu кладёт логотип именно здесь; в других сборках путь может отличаться.
const DEFAULT_LOGO = 'config/fancymenu/assets/logo.png';
const LOGO_CANDIDATES = [
  DEFAULT_LOGO,
  'config/fancymenu/assets/icon.png',
  'icon.png',
  'logo.png',
];

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const MAX_LOGO_BYTES = 4 * 1024 * 1024;

/** Сколько файлов сборки ещё не совпадает с манифестом. */
function pendingFiles(pack, state) {
  const installed = state.files || {};
  let missing = 0;

  for (const file of pack.files || []) {
    if (!installed[file.path]) missing += 1;
  }

  return missing;
}

async function readLogo(file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_LOGO_BYTES) return null;

    const extension = path.extname(file).toLowerCase();
    const mime = MIME[extension];
    if (!mime) return null;

    return `data:${mime};base64,${(await fsp.readFile(file)).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Возвращает состояние одной сборки:
 * installed — есть ли папка с хотя бы одной записью в state.json,
 * pending — сколько файлов из pack.json ещё не установлено (обновление/недокачка).
 */
async function packStatus(pack) {
  if (!pack || pack.demo) {
    return {
      id: pack?.id || null,
      installed: false,
      updateAvailable: false,
      pending: pack?.files?.length || 0,
    };
  }

  const dir = instanceDir(pack.id);
  const state = await readState(path.join(dir, '.launcher', 'state.json'));
  const known = Object.keys(state.files).length > 0;
  const exists = fs.existsSync(dir);
  const pending = pendingFiles(pack, state);

  return {
    id: pack.id,
    installed: exists && (known || pending === 0),
    updateAvailable: known && pending > 0,
    pending,
  };
}

/** Логотип: явный из manifest/pack.json, иначе стандартный путь FancyMenu. */
async function packLogo(pack, hint) {
  if (!pack) return null;

  const dir = instanceDir(pack.id);
  const candidates = [];

  for (const value of [pack.logo, hint, ...LOGO_CANDIDATES]) {
    if (!value) continue;
    const relative = String(value).replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!relative.includes('..')) candidates.push(relative);
  }

  for (const relative of new Set(candidates)) {
    const data = await readLogo(path.join(dir, relative));
    if (data) return data;
  }

  return null;
}

/** Сколько места занимает папка, в байтах. */
async function directorySize(dir) {
  let total = 0;
  let entries;

  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else if (entry.isFile()) {
      total += await fsp.stat(full).catch(() => ({ size: 0 })).then((stat) => stat.size);
    }
  }

  return total;
}

/** Удаляет папку сборки. Общие файлы Minecraft и кэш архивов не трогаем. */
async function deletePack(id) {
  const dir = instanceDir(id);
  const root = path.resolve(instancesDir);

  if (path.dirname(path.resolve(dir)) !== root) {
    throw new Error(`Недопустимая папка сборки: ${id}`);
  }

  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    await fsp.rmdir(root);
  } catch {
    // папка не пуста — оставляем
  }

  return { removed: true, directory: dir };
}

module.exports = {
  packStatus,
  packLogo,
  deletePack,
  directorySize,
  DEFAULT_LOGO,
  instanceDir,
  instancesDir,
  minecraftDir,
  cacheDir,
};
