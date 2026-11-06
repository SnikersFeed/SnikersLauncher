'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, shell } = require('electron');

const { fetchJson, downloadToFile } = require('./http');
const { getConfig, getLauncherRepo } = require('./config');

function parseVersion(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate, current) {
  const next = parseVersion(candidate);
  const prev = parseVersion(current);

  for (let index = 0; index < 3; index += 1) {
    if (next[index] > prev[index]) return true;
    if (next[index] < prev[index]) return false;
  }

  return false;
}

async function checkForUpdate() {
  const repo = getLauncherRepo();
  if (!repo) return null;

  const config = getConfig();
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!release || !release.tag_name) return null;

  const latestVersion = String(release.tag_name).replace(/^v/i, '');
  const currentVersion = app.getVersion();

  if (!isNewer(latestVersion, currentVersion)) return null;

  let pattern;
  try {
    pattern = new RegExp(config.updateAssetPattern || '\\.exe$', 'i');
  } catch {
    pattern = /\.exe$/i;
  }

  const asset = (release.assets || []).find((item) => pattern.test(item.name));

  return {
    version: latestVersion,
    currentVersion,
    notes: release.body || '',
    releaseUrl: release.html_url,
    assetUrl: asset?.browser_download_url || null,
    assetName: asset?.name || null,
    assetSize: asset?.size || 0,
  };
}

async function downloadAndInstallUpdate(info, options = {}) {
  const { onProgress = () => {} } = options;

  if (!info?.assetUrl || !info?.assetName) {
    throw new Error('В релизе не найден установщик. Скачайте обновление вручную.');
  }

  const destination = path.join(app.getPath('temp'), info.assetName);
  await downloadToFile(info.assetUrl, destination, {
    size: info.assetSize || 0,
    onProgress,
  });

  const config = getConfig();

  if (process.platform === 'win32') {
    const args = config.silentUpdate ? ['/S'] : [];
    const child = spawn(destination, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    setTimeout(() => app.quit(), 500);
    return { launched: true, file: destination };
  }

  await shell.openPath(destination);
  return { launched: true, file: destination, manual: true };
}

module.exports = {
  checkForUpdate,
  downloadAndInstallUpdate,
  isNewer,
  parseVersion,
};
