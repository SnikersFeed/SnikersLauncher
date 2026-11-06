'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  // Репозиторий, откуда читаются manifest.json и pack.json
  repo: 'OWNER/REPO',
  branch: 'main',
  manifestPath: 'manifest.json',
  // Прямая ссылка на манифест. Если задана — repo/branch/manifestPath игнорируются.
  manifestUrl: '',
  // Репозиторий, из релизов которого обновляется сам лаунчер
  launcherRepo: 'OWNER/REPO',
  // Какой asset из релиза считать установщиком
  updateAssetPattern: '\\.exe$',
  // Запускать установщик молча (/S)
  silentUpdate: false
};

let cached = null;

function bundledConfigPath() {
  return path.join(app.getAppPath(), 'config', 'launcher.json');
}

function userConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function getConfig() {
  if (cached) return cached;

  const bundled = readJson(bundledConfigPath());
  const user = readJson(userConfigPath());
  const fromEnv = process.env.SMC_CONFIG ? readJson(process.env.SMC_CONFIG) : {};

  cached = { ...DEFAULT_CONFIG, ...bundled, ...fromEnv, ...user };
  return cached;
}

/**
 * Сохраняет пользовательские настройки (ник, выбранная сборка, память, Java).
 * Не секреты, поэтому пишем обычным JSON в userData.
 */
function setUserConfig(patch) {
  const next = { ...getConfig(), ...patch };
  cached = next;

  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function isPlaceholderRepo(repo) {
  return !repo || /^OWNER\/REPO$/i.test(String(repo).trim());
}

function getManifestUrl() {
  const config = getConfig();
  if (config.manifestUrl) return config.manifestUrl;
  if (isPlaceholderRepo(config.repo)) return '';
  return `https://raw.githubusercontent.com/${config.repo}/${config.branch}/${config.manifestPath}`;
}

function getLauncherRepo() {
  const config = getConfig();
  if (isPlaceholderRepo(config.launcherRepo)) return '';
  return config.launcherRepo;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  setUserConfig,
  getManifestUrl,
  getLauncherRepo,
  isPlaceholderRepo,
  bundledConfigPath,
  userConfigPath,
};
