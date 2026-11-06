'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const { downloadToFile, fileSha1, fileMatches } = require('./http');
const { instanceDir, cacheDir } = require('./paths');

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeEntryName(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    return {
      version: 1,
      files: parsed && typeof parsed.files === 'object' && parsed.files ? parsed.files : {},
    };
  } catch {
    return { version: 1, files: {} };
  }
}

async function ensureArchive(pack, options) {
  const { onProgress, signal } = options;

  if (!pack.archive) {
    throw new Error(`В сборке "${pack.name}" нет архива, а часть файлов не имеет прямой ссылки`);
  }

  const key = pack.archive.sha1 || crypto.createHash('sha1').update(pack.archive.url).digest('hex');
  const archivePath = path.join(cacheDir, 'archives', `${key}.zip`);

  if (await fileMatches(archivePath, pack.archive.sha1, pack.archive.size)) {
    return archivePath;
  }

  await downloadToFile(pack.archive.url, archivePath, {
    sha1: pack.archive.sha1,
    size: pack.archive.size,
    signal,
    onProgress: (progress) => {
      onProgress({
        percent: progress.percent === null ? null : 20 + progress.percent * 0.3,
        label: 'Загрузка архива сборки',
      });
    },
  });

  return archivePath;
}

function extractEntry(zip, entry, item, signal) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }

      const hash = crypto.createHash('sha1');
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      fsp
        .mkdir(path.dirname(item.target), { recursive: true })
        .then(() => pipeline(readStream, meter, fs.createWriteStream(item.target), { signal }))
        .then(() => {
          const actual = hash.digest('hex');
          if (item.sha1 && actual !== String(item.sha1).toLowerCase()) {
            throw new Error(`SHA1 не совпал для "${item.path}" внутри архива`);
          }
          resolve(actual);
        })
        .catch(async (streamError) => {
          await fsp.rm(item.target, { force: true }).catch(() => {});
          reject(streamError);
        });
    });
  });
}

/**
 * Распаковывает нужные файлы за один проход по zip.
 * Это критично для больших сборок: переоткрывать архив на каждый файл нельзя.
 *
 * items: [{ path, entry, target, sha1 }]
 * options: { signal, onFile(item, actualSha1) }
 */
async function extractFromArchive(archivePath, items, options = {}) {
  const { signal, onFile = () => {} } = options;

  const pending = new Map();
  for (const item of items) {
    pending.set(normalizeEntryName(item.entry || item.path), item);
  }

  if (pending.size === 0) return;

  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }

      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch {
          // архив уже закрыт
        }
        reject(error);
      };

      zip.on('error', fail);

      zip.on('end', () => {
        if (settled) return;

        if (pending.size > 0) {
          const missing = [...pending.values()]
            .slice(0, 5)
            .map((item) => item.entry || item.path)
            .join(', ');
          fail(new Error(`В архиве сборки нет файлов: ${missing}`));
          return;
        }

        settled = true;
        resolve();
      });

      zip.on('entry', (entry) => {
        const name = normalizeEntryName(entry.fileName);
        const item = pending.get(name);

        if (!item || name.endsWith('/')) {
          zip.readEntry();
          return;
        }

        pending.delete(name);

        extractEntry(zip, entry, item, signal)
          .then((actual) => {
            if (settled) return;
            onFile(item, actual);
            zip.readEntry();
          })
          .catch(fail);
      });

      zip.readEntry();
    });
  });
}

/**
 * Приводит папку сборки к состоянию из pack.json.
 * Удаляет только те файлы, которые лаунчер сам устанавливал ранее.
 */
async function syncInstance(pack, options = {}) {
  const { onStatus = () => {}, onProgress = () => {}, signal } = options;

  const dir = instanceDir(pack.id);
  const statePath = path.join(dir, '.launcher', 'state.json');
  const state = await readState(statePath);

  const previous = new Map(Object.entries(state.files));
  const desired = new Map(pack.files.map((file) => [file.path, file]));

  let lastProgressAt = 0;
  const report = (percent, label, force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 100) return;
    lastProgressAt = now;
    onProgress({ percent, label });
  };

  await fsp.mkdir(dir, { recursive: true });

  onStatus('Проверка файлов сборки…');
  const toInstall = [];
  let checked = 0;

  for (const [relativePath, file] of desired) {
    const target = path.join(dir, relativePath);
    const knownSha1 = previous.get(relativePath);
    const stat = await fsp.stat(target).catch(() => null);

    let valid = false;

    if (stat && stat.isFile()) {
      if (file.size > 0 && stat.size !== file.size) {
        valid = false;
      } else if (file.sha1 && knownSha1 === file.sha1) {
        // Файл уже установлен этим лаунчером и манифест не изменился.
        valid = true;
      } else if (!file.sha1) {
        valid = true;
      } else {
        valid = (await fileSha1(target)) === file.sha1;
      }
    }

    if (valid) {
      if (file.sha1) previous.set(relativePath, file.sha1);
    } else {
      toInstall.push(file);
    }

    checked += 1;
    report(desired.size ? (checked / desired.size) * 20 : 20, 'Проверка файлов');
  }

  if (toInstall.length === 0) {
    report(100, 'Файлы сборки актуальны', true);
  }

  const directFiles = toInstall.filter((file) => file.url);
  const archiveFiles = toInstall.filter((file) => !file.url);

  let archivePath = null;
  if (archiveFiles.length > 0) {
    archivePath = await ensureArchive(pack, { onStatus, onProgress, signal });
  }

  for (let index = 0; index < directFiles.length; index += 1) {
    const file = directFiles[index];
    const target = path.join(dir, file.path);

    onStatus(`Скачивание ${file.path}…`);
    const result = await downloadToFile(file.url, target, {
      sha1: file.sha1,
      size: file.size,
      signal,
      onProgress: (progress) => {
        const share = progress.percent === null ? 0 : progress.percent / 100;
        report(
          50 + ((index + share) / directFiles.length) * 20,
          `Скачивание ${file.path}`
        );
      },
    });

    previous.set(file.path, result.sha1);
  }

  if (archiveFiles.length > 0) {
    onStatus(`Распаковка файлов сборки (${archiveFiles.length})…`);

    const items = archiveFiles.map((file) => ({
      path: file.path,
      entry: file.entry || file.path,
      sha1: file.sha1,
      target: path.join(dir, file.path),
    }));

    let extracted = 0;
    await extractFromArchive(archivePath, items, {
      signal,
      onFile: (item, actual) => {
        previous.set(item.path, item.sha1 || actual);
        extracted += 1;
        report(
          70 + (extracted / archiveFiles.length) * 25,
          `Распаковка ${item.path}`
        );
      },
    });
  }

  let removed = 0;
  if (pack.deleteObsolete) {
    onStatus('Удаление устаревших файлов…');
    for (const relativePath of [...previous.keys()]) {
      if (desired.has(relativePath)) continue;

      const target = path.join(dir, relativePath);
      if (!isInside(dir, target)) continue;

      await fsp.rm(target, { force: true });
      previous.delete(relativePath);
      removed += 1;
    }
  }

  const nextState = { version: 1, files: Object.fromEntries(previous) };
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(nextState, null, 2), 'utf8');

  report(100, 'Готово', true);

  return {
    directory: dir,
    updated: toInstall.length,
    removed,
  };
}

module.exports = {
  syncInstance,
  ensureArchive,
  extractFromArchive,
  readState,
};
