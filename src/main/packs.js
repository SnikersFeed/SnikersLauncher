'use strict';

const { fetchJson } = require('./http');
const { getManifestUrl } = require('./config');

const DEMO_PACK = {
  schemaVersion: 1,
  id: 'vanilla-1.20.1',
  name: 'Vanilla 1.20.1',
  description:
    'Демо-сборка без модов. Чтобы подключить свои сборки, укажите GitHub-репозиторий в config/launcher.json.',
  minecraft: '1.20.1',
  loader: { type: 'vanilla' },
  java: 17,
  memory: { minMb: 2048, maxMb: 4096 },
  files: [],
  archive: null,
  jvmArgs: [],
  gameArgs: [],
  deleteObsolete: true,
  demo: true,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [];
}

/** "2G" / "2048M" / 2048 -> мегабайты */
function toMegabytes(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(512, Math.round(value));
  if (typeof value !== 'string') return fallback;

  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([gGmM])?$/);
  if (!match) return fallback;

  const amount = Number(match[1]);
  const unit = (match[2] || 'M').toUpperCase();
  const megabytes = unit === 'G' ? amount * 1024 : amount;
  return Math.max(512, Math.round(megabytes));
}

function normalizeMemory(raw) {
  const value = isPlainObject(raw) ? raw : {};
  return {
    minMb: toMegabytes(value.minMb ?? value.min, 2048),
    maxMb: toMegabytes(value.maxMb ?? value.max, 4096),
  };
}

function normalizeLoader(raw) {
  if (!raw) return { type: 'vanilla' };

  const value = typeof raw === 'string' ? { type: raw } : raw;
  const type = String(value.type || 'vanilla').toLowerCase();
  const loader = { type };

  if (value.version) loader.version = String(value.version);
  if (value.project) loader.project = String(value.project);

  if (type !== 'vanilla' && !loader.version) {
    throw new Error(`В сборке не указана версия загрузчика ${type}`);
  }

  if (!['vanilla', 'fabric', 'forge', 'neoforge'].includes(type)) {
    throw new Error(`Неподдерживаемый загрузчик: ${type}`);
  }

  return loader;
}

function normalizeJava(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  if (isPlainObject(raw) && raw.major) return Number(raw.major);
  return null;
}

function sanitizeRelativePath(input) {
  const value = String(input || '').replace(/\\/g, '/').trim();
  if (!value) throw new Error('Пустой путь файла в сборке');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`Абсолютный путь запрещён: ${input}`);
  }

  const parts = value.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new Error(`Путь выходит за пределы сборки: ${input}`);
  }

  return parts.join('/');
}

function resolveUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(String(value), baseUrl).toString();
  } catch {
    throw new Error(`Некорректная ссылка: ${value}`);
  }
}

function normalizePack(raw, packUrl) {
  if (!isPlainObject(raw)) throw new Error('pack.json должен содержать объект');
  if (!raw.id) throw new Error('В pack.json отсутствует id');
  if (!raw.minecraft) throw new Error(`В сборке ${raw.id} отсутствует minecraft`);

  const archiveRaw = raw.archive;
  const archive = isPlainObject(archiveRaw) && archiveRaw.url
    ? {
        url: resolveUrl(archiveRaw.url, packUrl),
        sha1: archiveRaw.sha1 ? String(archiveRaw.sha1).toLowerCase() : null,
        size: Number(archiveRaw.size) || 0,
      }
    : null;

  const files = (Array.isArray(raw.files) ? raw.files : []).map((file) => {
    if (!isPlainObject(file) || !file.path) {
      throw new Error(`В сборке ${raw.id} найден файл без path`);
    }

    const filePath = sanitizeRelativePath(file.path);

    return {
      path: filePath,
      entry: file.entry ? sanitizeRelativePath(file.entry) : filePath,
      url: file.url ? resolveUrl(file.url, packUrl) : null,
      sha1: file.sha1 ? String(file.sha1).toLowerCase() : null,
      size: Number(file.size) || 0,
    };
  });

  return {
    schemaVersion: Number(raw.schemaVersion) || 1,
    id: String(raw.id),
    name: String(raw.name || raw.id),
    description: String(raw.description || ''),
    minecraft: String(raw.minecraft),
    loader: normalizeLoader(raw.loader),
    java: normalizeJava(raw.java),
    memory: normalizeMemory(raw.memory),
    jvmArgs: toArray(raw.jvmArgs),
    gameArgs: toArray(raw.gameArgs),
    server: isPlainObject(raw.server) ? raw.server : null,
    resolution: isPlainObject(raw.resolution) ? raw.resolution : null,
    files,
    archive,
    deleteObsolete: raw.deleteObsolete !== false,
    demo: false,
  };
}

async function loadManifest() {
  const manifestUrl = getManifestUrl();
  if (!manifestUrl) {
    const error = new Error(
      'Не настроен GitHub-репозиторий. Откройте config/launcher.json и укажите repo (например, "user/mc-packs").'
    );
    error.code = 'NO_REPO';
    throw error;
  }

  const manifest = await fetchJson(manifestUrl);
  if (!isPlainObject(manifest) || !Array.isArray(manifest.packs)) {
    throw new Error('manifest.json должен содержать массив packs');
  }

  return { manifestUrl, manifest };
}

async function listPacks() {
  try {
    const { manifestUrl, manifest } = await loadManifest();

    const packs = manifest.packs
      .filter((entry) => isPlainObject(entry) && entry.id)
      .map((entry) => ({
        id: String(entry.id),
        name: String(entry.name || entry.id),
        description: String(entry.description || ''),
        icon: entry.icon || null,
        manifest: entry.manifest || `packs/${entry.id}/pack.json`,
        _manifestUrl: manifestUrl,
      }));

    if (packs.length === 0) {
      return { packs: [], error: 'В manifest.json нет ни одной сборки' };
    }

    return { packs, error: null };
  } catch (error) {
    return {
      packs: [DEMO_PACK],
      error: error.message,
      demo: true,
    };
  }
}

async function getPack(id) {
  if (!id || id === DEMO_PACK.id) return DEMO_PACK;

  const { manifestUrl, manifest } = await loadManifest();
  const entry = manifest.packs.find((item) => isPlainObject(item) && String(item.id) === String(id));
  if (!entry) throw new Error(`Сборка "${id}" не найдена в manifest.json`);

  const packResource = entry.manifest || `packs/${entry.id}/pack.json`;
  const packUrl = resolveUrl(packResource, manifestUrl);
  const rawPack = await fetchJson(packUrl);

  const pack = normalizePack(rawPack, packUrl);
  if (entry.name && !rawPack.name) pack.name = String(entry.name);
  if (entry.description && !rawPack.description) pack.description = String(entry.description);

  return pack;
}

module.exports = {
  DEMO_PACK,
  listPacks,
  getPack,
  normalizePack,
  sanitizeRelativePath,
  toMegabytes,
  normalizeMemory,
  resolveUrl,
};
