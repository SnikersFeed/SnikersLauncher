'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const USER_AGENT = 'SimpleMCLauncher/1.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(headers = {}) {
  return {
    'User-Agent': USER_AGENT,
    ...headers,
  };
}

async function fetchWithRetry(url, options = {}, tries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...options,
        headers: buildHeaders({ ...(options.headers || {}) }),
      });

      // 5xx и 429 имеет смысл повторить, 4xx — нет.
      if (response.status >= 500 || response.status === 429) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < tries && !options.signal?.aborted) {
        await sleep(400 * attempt);
        continue;
      }
      break;
    }
  }

  throw new Error(`Не удалось выполнить запрос к ${url}: ${lastError?.message || lastError}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, {
    cache: 'no-store',
    ...options,
    headers: {
      'Cache-Control': 'no-cache',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} при загрузке ${url}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Некорректный JSON по адресу ${url}`);
  }
}

async function fileSha1(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

async function fileMatches(file, sha1, size) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    if (typeof size === 'number' && size >= 0 && stat.size !== size) return false;
    if (!sha1) return true;
    return (await fileSha1(file)) === String(sha1).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Скачивает файл с проверкой SHA1 и прогрессом.
 * Пишет во временный файл и переименовывает только после успешной проверки.
 */
async function downloadToFile(url, destination, options = {}) {
  const { sha1, size, onProgress, signal } = options;

  await fsp.mkdir(path.dirname(destination), { recursive: true });

  const temp = `${destination}.${process.pid}.${Date.now()}.part`;
  const response = await fetchWithRetry(url, { signal });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} при скачивании ${url}`);
  }

  const total = Number(response.headers.get('content-length')) || Number(size) || 0;
  const hash = crypto.createHash('sha1');
  let received = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      received += chunk.length;
      if (onProgress) onProgress({ received, total, percent: total ? (received / total) * 100 : null });
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temp), { signal });

    const actual = hash.digest('hex').toLowerCase();
    if (sha1 && actual !== String(sha1).toLowerCase()) {
      throw new Error(`SHA1 не совпал для ${path.basename(destination)} (ожидался ${sha1}, получен ${actual})`);
    }

    if (typeof size === 'number' && size > 0 && received !== size) {
      throw new Error(`Размер ${path.basename(destination)} не совпал (ожидался ${size}, получен ${received})`);
    }

    await fsp.rename(temp, destination);
    return { sha1: actual, size: received };
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  USER_AGENT,
  fetchJson,
  fetchWithRetry,
  downloadToFile,
  fileSha1,
  fileMatches,
};
