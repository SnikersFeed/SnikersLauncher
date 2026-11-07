'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
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

function fail(message) {
  throw new Error(message);
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

  // Лёгкий ассет только с app.asar — если он опубликован, обновляемся им без установщика.
  const asarAsset = (release.assets || []).find((item) => /\.asar$/i.test(item.name));

  const source = asarAsset || asset;

  return {
    version: latestVersion,
    currentVersion,
    notes: release.body || '',
    releaseUrl: release.html_url,
    assetUrl: source?.browser_download_url || null,
    assetName: source?.name || null,
    assetSize: source?.size || 0,
    // true — ассет это чистый app.asar, false — установщик/архив
    asarAsset: Boolean(asarAsset),
  };
}

function rmrf(target) {
  return fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function findOnce(dir, predicate, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 6) {
      const found = findOnce(full, predicate, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && predicate(entry.name)) {
      return full;
    }
  }

  return null;
}

async function extractZip(zipFile, destination) {
  const yauzl = require('yauzl');

  const zip = await new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (error, handle) => {
      if (error) reject(error);
      else resolve(handle);
    });
  });

  await fsp.mkdir(destination, { recursive: true });
  const root = path.resolve(destination);

  await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      const target = path.resolve(root, entry.fileName);
      const isDir = /\/$/.test(entry.fileName);

      if (!target.startsWith(root + path.sep) && target !== root) {
        zip.readEntry();
        return;
      }

      if (isDir) {
        fsp
          .mkdir(target, { recursive: true })
          .then(() => zip.readEntry())
          .catch(reject);
        return;
      }

      zip.openReadStream(entry, async (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        try {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const output = fs.createWriteStream(target);
          await new Promise((done, failed) => {
            stream.on('error', failed);
            output.on('error', failed);
            output.on('finish', done);
            stream.pipe(output);
          });
          zip.readEntry();
        } catch (caught) {
          reject(caught);
        }
      });
    });

    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
}

/**
 * Готовит новую сборку приложения рядом с текущей установкой:
 * скачивает релиз, распаковывает его во временную папку и оставляет там файлы,
 * которые нужно перенести в установленную папку.
 */
async function prepareUpdate(info, options = {}) {
  const { onStatus = () => {}, onProgress = () => {} } = options;

  if (process.platform !== 'win32') {
    fail('Скрытое обновление поддерживается только в Windows. Обновите лаунчер вручную.');
  }

  if (!info?.assetUrl || !info?.assetName) {
    fail('В релизе не найден файл обновления. Скачайте обновление вручную.');
  }

  // Папку установки берём не из process.execPath, а из реально загруженного app.asar:
  // <папка установки>\resources\app.asar.
  const resourcesDir = path.dirname(String(app.getAppPath()));
  const appDir = path.dirname(resourcesDir);
  const asarPath = path.join(resourcesDir, 'app.asar');

  // fs.access на путь app.asar не работает: Electron считает архив виртуальной
  // папкой и ищет файл внутри него. existsSync проверяет сам файл на диске.
  if (!fs.existsSync(asarPath)) {
    fail(
      'Лаунчер запущен не из установленной папки, автоматическое обновление недоступно. ' +
        'Скачайте обновление вручную.'
    );
  }

  if (fs.existsSync(path.join(appDir, 'portable'))) {
    fail('Портативная версия автоматически не обновляется. Скачайте обновление вручную.');
  }

  const staging = path.join(app.getPath('temp'), 'smc-update', String(info.version));
  await rmrf(staging);
  await fsp.mkdir(staging, { recursive: true });

  const archive = path.join(staging, info.assetName);
  onStatus?.('Скачивание обновления лаунчера…');
  await downloadToFile(info.assetUrl, archive, {
    size: info.assetSize || 0,
    onProgress,
  });

  onStatus?.('Распаковка обновления…');
  const extracted = path.join(staging, 'extracted');
  await fsp.mkdir(extracted, { recursive: true });
  const isZip = /\.zip$/i.test(info.assetName);
  const isAsar = /\.asar$/i.test(info.assetName) || info.asarAsset;

  if (isAsar) {
    await fsp.rename(archive, path.join(extracted, 'app.asar'));
  } else if (isZip || !/\.exe$/i.test(info.assetName)) {
    await extractZip(archive, extracted);
  } else {
    // Обычный установщик electron-builder — распаковываем 7z-архив app.asar наружу,
    // чтобы не прогонять пользователя через установку.
    const sevenZip = require('7zip-bin');
    const unpacked = path.join(extracted, 'unpacked');
    await fsp.mkdir(unpacked, { recursive: true });
    await runQuiet(sevenZip.path7za, ['x', '-bd', '-y', `-o${unpacked}`, archive]);
    const unpackedAsar = findOnce(unpacked, (name) => name === 'app.asar');
    if (!unpackedAsar) fail('В установщике не найден app.asar.');
    await fsp.rename(unpackedAsar, path.join(extracted, 'app.asar'));

    const unpackedYml = path.join(path.dirname(unpackedAsar), 'app-update.yml');
    if (fs.existsSync(unpackedYml)) {
      await fsp.rename(unpackedYml, path.join(extracted, 'app-update.yml'));
    }
    await rmrf(unpacked);
  }

  const stagedAsar = path.join(extracted, 'app.asar');
  if (!fs.existsSync(stagedAsar)) {
    const found = findOnce(extracted, (name) => name === 'app.asar');
    if (!found) fail('В загруженном обновлении не найден app.asar.');
    await fsp.rename(found, stagedAsar);
  }

  await rmrf(archive);

  return {
    staging,
    extracted,
    appDir,
    stagedAsar,
    stagedUpdateYml: fs.existsSync(path.join(extracted, 'app-update.yml'))
      ? path.join(extracted, 'app-update.yml')
      : null,
  };
}

function runQuiet(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Распаковка обновления завершилась с кодом ${code}`));
    });
  });
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Запускает отложенный скрипт, который дожидается выхода лаунчера,
 * подменяет файлы в установленной папке и снова запускает лаунчер.
 */
function writeApplyScript(update) {
  const appExe = process.execPath;
  const logFile = path.join(update.staging, 'apply.log');

  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$log = ${powershellQuote(logFile)}`,
    `function Log($text) { try { Add-Content -LiteralPath $log -Value ("[" + (Get-Date -Format "HH:mm:ss") + "] " + $text) -Encoding UTF8 } catch {} }`,
    `trap { Log ("Неожиданная ошибка: " + $_.Exception.Message); exit 1 }`,
    `$appDir = ${powershellQuote(update.appDir)}`,
    `$exe = ${powershellQuote(appExe)}`,
    `$launcherPid = ${update.launcherPid || process.pid}`,
    `Log "Ожидание выхода лаунчера ($launcherPid)"`,
    // Wait-Process может вернуться сразу, если процесс ему «чужой» — ждём опросом.
    `$deadline = (Get-Date).AddSeconds(180)`,
    `while ((Get-Date) -lt $deadline) {`,
    `  if (-not (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)) { break }`,
    `  Start-Sleep -Milliseconds 250`,
    `}`,
    `Start-Sleep -Milliseconds 800`,
    `$moves = @(`,
    `  @{ From = ${powershellQuote(update.stagedAsar)}; To = (Join-Path $appDir 'resources\\app.asar') }`,
    ...(update.stagedUpdateYml
      ? [`  @{ From = ${powershellQuote(update.stagedUpdateYml)}; To = (Join-Path $appDir 'resources\\app-update.yml') }`]
      : []),
    `)`,
    `$done = $true`,
    `foreach ($item in $moves) {`,
    `  if (-not (Test-Path -LiteralPath $item.From)) { continue }`,
    `  try {`,
    `    Copy-Item -LiteralPath $item.From -Destination $item.To -Force`,
    `    Log ("Обновлён " + $item.To)`,
    `  } catch {`,
    `    Log ("Ошибка замены " + $item.To + ": " + $_.Exception.Message)`,
    `    $done = $false`,
    `  }`,
    `}`,
    `Start-Sleep -Milliseconds 400`,
    // Убираем временные файлы до запуска, иначе папку может держать уже новый процесс.
    `if ($done) {`,
    `  Set-Location -LiteralPath $env:TEMP`,
    `  try { Remove-Item -LiteralPath ${powershellQuote(update.staging)} -Recurse -Force -ErrorAction SilentlyContinue } catch {}`,
    `}`,
    `try { Start-Process -FilePath $exe -WorkingDirectory $appDir } catch { Log ("Ошибка запуска: " + $_.Exception.Message) }`,
    `Log "Готово (done=$done)"`,
  ];

  const file = path.join(update.staging, 'apply-update.ps1');
  fs.writeFileSync(file, `\ufeff${lines.join('\r\n')}\r\n`, 'utf8');
  return file;
}

async function applyUpdateAndRestart(update) {
  const script = writeApplyScript(update);

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      script,
    ],
    {
      // detached здесь нельзя: на Windows такой процесс молча завершается сразу.
      windowsHide: true,
      stdio: 'ignore',
      cwd: update.staging,
    }
  );

  if (process.env.SMC_UPDATE_DEBUG) {
    console.log('[updater] powershell pid:', child.pid, 'script:', script);
    child.once('exit', (code) => console.log('[updater] powershell exited:', code));
  }

  // Небольшая проверка, что процесс действительно запустился — иначе пользователь
  // останется без лаунчера после закрытия окна.
  await new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Не удалось запустить скрипт обновления: ${error.message}`));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, 400);
  });

  child.unref();
  setTimeout(() => app.quit(), 300);
  return { launched: true, staging: update.staging, appDir: update.appDir };
}

async function downloadAndInstallUpdate(info, options = {}) {
  if (process.platform !== 'win32') {
    // На других платформах — прежнее поведение: открыть скачанный установщик.
    const destination = path.join(app.getPath('temp'), info?.assetName || 'launcher-update');
    await downloadToFile(info.assetUrl, destination, {
      size: info.assetSize || 0,
      onProgress: options.onProgress,
    });
    await shell.openPath(destination);
    return { launched: true, file: destination, manual: true };
  }

  const update = await prepareUpdate(info, options);
  options.onStatus?.('Установка обновления и перезапуск…');
  return applyUpdateAndRestart(update);
}

module.exports = {
  checkForUpdate,
  prepareUpdate,
  applyUpdateAndRestart,
  writeApplyScript,
  downloadAndInstallUpdate,
  isNewer,
  parseVersion,
  extractZip,
};
