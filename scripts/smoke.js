'use strict';

/**
 * Локальный smoke-тест без запуска Electron-окна.
 * Подменяет модуль electron и проверяет разбор манифестов, обновление файлов и утилиты.
 *
 * Запуск: npm test
 */

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smc-smoke-'));

const fakeElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? path.join(tempRoot, 'userData') : tempRoot),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.0.0',
    quit: () => {},
  },
  shell: { openPath: async () => '', openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  dialog: {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const AdmZip = require('adm-zip');
const { normalizePack, sanitizeRelativePath, toMegabytes, getPack } = require('../src/main/packs');
const { syncInstance } = require('../src/main/sync');
const {
  offlineUuid,
  requiredJavaMajor,
  parseJavaVersionText,
  pickJava,
  loaderInstallKey,
  readInstallMarker,
  writeInstallMarker,
  canReuseInstall,
} = require('../src/main/minecraft');
const { isNewer, extractZip, prepareUpdate, writeApplyScript, takeUpdateResult } = require('../src/main/updater');
const { packReleaseSource } = require('../src/main/changelog');
const { packStatus, packLogo, deletePack } = require('../src/main/instances');
const { parseAddress, motdText } = require('../src/main/server');
const { recommendedMemoryMb } = require('../src/main/packs');
const {
  OFFICIAL_MAVEN,
  MIRROR_MAVENS,
  neoforgeInstallerPath,
  makeLibraryHost,
} = require('../src/main/maven');

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeZip(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content));
  }
  const file = path.join(tempRoot, `pack-${Math.random().toString(16).slice(2)}.zip`);
  zip.writeZip(file);
  return { file, buffer: fs.readFileSync(file) };
}

async function main() {
  // --- утилиты ---
  assert.equal(isNewer('1.2.0', '1.1.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('v2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.0.1', '1.0.0'), true);

  assert.equal(toMegabytes('2G'), 2048);
  assert.equal(toMegabytes('1536M'), 1536);
  assert.equal(toMegabytes(3072), 3072);

  assert.throws(() => sanitizeRelativePath('../secret.txt'));
  assert.throws(() => sanitizeRelativePath('C:/Windows/system32'));

  const uuid = offlineUuid('Steve');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuid, offlineUuid('Steve'));

  assert.equal(requiredJavaMajor('1.20.1'), 17);
  assert.equal(requiredJavaMajor('1.21.1'), 21);
  assert.equal(requiredJavaMajor('1.16.5'), 8);

  // Java 22 не должна подменять 21: Cobblemon требует строго 21.
  assert.equal(pickJava([{ majorVersion: 22, version: '22.0.1' }], 21), null);
  assert.equal(
    pickJava(
      [
        { majorVersion: 22, version: '22.0.1' },
        { majorVersion: 21, version: '21.0.5' },
      ],
      21
    ).majorVersion,
    21
  );

  // Java 8 с дефисом в версии раньше ронял resolveJava из @xmcl/installer.
  assert.deepEqual(parseJavaVersionText('openjdk version "1.8.0-262"'), {
    version: '1.8.0-262',
    majorVersion: 8,
    patch: 262,
  });
  assert.equal(parseJavaVersionText('java version "1.8.0_402"').majorVersion, 8);
  assert.equal(parseJavaVersionText('openjdk version "17.0.5" 2022-10-18').majorVersion, 17);
  assert.equal(parseJavaVersionText('openjdk version "21" 2023-09-19').majorVersion, 21);
  assert.equal(parseJavaVersionText('no version here'), null);

  // --- зеркала Maven для загрузчиков ---
  assert.match(OFFICIAL_MAVEN, /^https:\/\/maven\.neoforged\.net\/releases\/$/);
  assert.ok(MIRROR_MAVENS.length >= 2, 'нужно хотя бы два зеркала');
  assert.equal(
    neoforgeInstallerPath('neoforge', '21.1.215'),
    'net/neoforged/neoforge/21.1.215/neoforge-21.1.215-installer.jar'
  );
  assert.equal(
    neoforgeInstallerPath('forge', '1.20.1-47.4.0'),
    'net/neoforged/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar'
  );

  const libraryHost = makeLibraryHost();
  const urls = libraryHost({
    download: { path: 'cpw/mods/modlauncher/11.0.5/modlauncher-11.0.5.jar' },
  });
  assert.deepEqual(
    urls,
    MIRROR_MAVENS.map((host) => `${host}cpw/mods/modlauncher/11.0.5/modlauncher-11.0.5.jar`)
  );
  // Официальный хост идёт через mavenHost, зеркала — через libraryHost.
  assert.equal(urls.some((url) => url.startsWith(OFFICIAL_MAVEN)), false);
  assert.deepEqual(libraryHost({}), []);
  assert.deepEqual(libraryHost(), []);

  // --- индикатор сервера ---
  assert.deepEqual(parseAddress('89.232.194.169:25565'), {
    host: '89.232.194.169',
    port: 25565,
  });
  assert.deepEqual(parseAddress('example.com'), { host: 'example.com', port: 25565 });
  assert.equal(parseAddress('  '), null);
  assert.equal(motdText({ text: '§aHello ', extra: [{ text: 'world' }] }), 'Hello world');

  // --- сервер с архивами ---
  const v1 = makeZip({ 'mods/a.jar': 'v1', 'config/test.txt': 'cfg' });
  const v2 = makeZip({ 'mods/a.jar': 'v2', 'mods/b.jar': 'new' });

  let currentArchive = v1.buffer;
  const server = http.createServer((request, response) => {
    if (request.url === '/test-manifest.json') {
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          packs: [{ id: 'manifest-id', name: 'Manifest', manifest: '/test-pack.json' }],
        })
      );
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/test-pack.json') {
      const body = Buffer.from(
        JSON.stringify({ id: 'stale-id', minecraft: '1.20.1', loader: { type: 'vanilla' } })
      );
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
      response.end(body);
      return;
    }
    if (request.url === '/direct.jar') {
      const body = Buffer.from('direct');
      response.writeHead(200, { 'Content-Length': body.length });
      response.end(body);
      return;
    }
    response.writeHead(200, { 'Content-Length': currentArchive.length });
    response.end(currentArchive);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // --- id сборки берётся из manifest, а не из pack.json ---
  // Скопированный pack.json не должен приводить к общей папке установки.
  fs.mkdirSync(path.join(tempRoot, 'userData'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, 'userData', 'config.json'),
    JSON.stringify({ manifestUrl: `${base}/test-manifest.json` })
  );
  const manifestPack = await getPack('manifest-id');
  assert.equal(manifestPack.id, 'manifest-id');
  assert.equal(manifestPack.minecraft, '1.20.1');

  const makePack = (archive) =>
    normalizePack(
      {
        id: 'test-pack',
        name: 'Test Pack',
        description: 'smoke',
        minecraft: '1.20.1',
        loader: { type: 'vanilla' },
        files: archive.files,
        archive: { url: `${base}/pack.zip`, sha1: sha1(archive.buffer), size: archive.buffer.length },
      },
      `${base}/pack.json`
    );

  const pack1 = makePack({
    buffer: v1.buffer,
    files: [
      { path: 'mods/a.jar', sha1: sha1('v1'), size: 2 },
      { path: 'config/test.txt', sha1: sha1('cfg'), size: 3 },
      { path: 'mods/direct.jar', url: `${base}/direct.jar`, sha1: sha1('direct'), size: 6 },
    ],
  });

  const first = await syncInstance(pack1);
  assert.equal(first.updated, 3);

  const instance = path.join(tempRoot, 'userData', 'data', 'instances', 'test-pack');
  assert.equal(fs.readFileSync(path.join(instance, 'mods/a.jar'), 'utf8'), 'v1');
  assert.equal(fs.readFileSync(path.join(instance, 'config/test.txt'), 'utf8'), 'cfg');
  assert.equal(fs.readFileSync(path.join(instance, 'mods/direct.jar'), 'utf8'), 'direct');

  const second = await syncInstance(pack1);
  assert.equal(second.updated, 0);
  assert.equal(second.removed, 0);

  // --- обновление: a.jar меняется, b.jar добавляется, config/test.txt удаляется ---
  currentArchive = v2.buffer;
  const pack2 = makePack({
    buffer: v2.buffer,
    files: [
      { path: 'mods/a.jar', sha1: sha1('v2'), size: 2 },
      { path: 'mods/b.jar', sha1: sha1('new'), size: 3 },
    ],
  });

  const third = await syncInstance(pack2);
  assert.equal(third.updated, 2);
  assert.equal(third.removed, 2); // config/test.txt и mods/direct.jar

  assert.equal(fs.readFileSync(path.join(instance, 'mods/a.jar'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(instance, 'mods/b.jar'), 'utf8'), 'new');
  assert.equal(fs.existsSync(path.join(instance, 'config/test.txt')), false);
  assert.equal(fs.existsSync(path.join(instance, 'mods/direct.jar')), false);

  // --- разбор манифеста ---
  const parsed = normalizePack(
    {
      id: 'p',
      minecraft: '1.21.1',
      loader: { type: 'neoforge', version: '21.1.80' },
      memory: { min: '2G', max: '8G' },
      files: [{ path: 'mods\\win.jar', url: 'files/win.jar' }],
    },
    'https://example.com/packs/p/pack.json'
  );

  assert.equal(parsed.loader.type, 'neoforge');
  assert.equal(parsed.memory.maxMb, 8192);
  assert.equal(parsed.files[0].path, 'mods/win.jar');
  assert.equal(parsed.files[0].url, 'https://example.com/packs/p/files/win.jar');

  assert.throws(() =>
    normalizePack({ id: 'bad', minecraft: '1.20.1', loader: { type: 'fabric' } }, 'https://example.com')
  );

  // --- маркер установки загрузчика: повторно не ставим при том же ключе ---
  const markerDir = path.join(tempRoot, 'marker-instance');
  const markerPack = normalizePack(
    { id: 'marker', minecraft: '1.21.1', loader: { type: 'neoforge', version: '21.1.249' } },
    'https://example.com/pack.json'
  );
  const markerKey = loaderInstallKey(markerPack);
  assert.equal(markerKey, '1.21.1|neoforge|neoforge|21.1.249');
  assert.equal(await readInstallMarker(markerDir), null);
  assert.equal(canReuseInstall(null, markerKey), false);

  const markerVersion = 'neoforge-21.1.249';
  await writeInstallMarker(markerDir, { key: markerKey, versionId: markerVersion });
  const marker = await readInstallMarker(markerDir);
  assert.equal(marker.key, markerKey);
  assert.equal(marker.versionId, markerVersion);
  assert.equal(canReuseInstall(marker, markerKey), false, 'без version json переиспользовать нельзя');

  const markerVersionDir = path.join(
    tempRoot,
    'userData',
    'data',
    'minecraft',
    'versions',
    markerVersion
  );
  fs.mkdirSync(markerVersionDir, { recursive: true });
  fs.writeFileSync(path.join(markerVersionDir, `${markerVersion}.json`), '{}');
  assert.equal(canReuseInstall(marker, markerKey), true);

  // Базовая версия Minecraft тоже должна быть на месте.
  assert.equal(canReuseInstall(marker, markerKey, '1.21.1'), false);
  const baseVersionDir = path.join(tempRoot, 'userData', 'data', 'minecraft', 'versions', '1.21.1');
  fs.mkdirSync(baseVersionDir, { recursive: true });
  fs.writeFileSync(path.join(baseVersionDir, '1.21.1.json'), '{}');
  assert.equal(canReuseInstall(marker, markerKey, '1.21.1'), true);

  const changedPack = normalizePack(
    { id: 'marker', minecraft: '1.21.1', loader: { type: 'neoforge', version: '21.1.250' } },
    'https://example.com/pack.json'
  );
  assert.equal(canReuseInstall(marker, loaderInstallKey(changedPack)), false);

  fs.rmSync(path.join(markerVersionDir, `${markerVersion}.json`));
  assert.equal(canReuseInstall(marker, markerKey), false, 'пропавшая версия ставится заново');

  // --- скрытое обновление: распаковка архива с app.asar ---
  const updateZip = makeZip({ 'nested/app.asar': 'new-asar', 'nested/app-update.yml': 'provider: github' });
  const updateOut = path.join(tempRoot, 'update-out');
  await extractZip(updateZip.file, updateOut);
  assert.equal(fs.readFileSync(path.join(updateOut, 'nested/app.asar'), 'utf8'), 'new-asar');
  assert.equal(fs.readFileSync(path.join(updateOut, 'nested/app-update.yml'), 'utf8'), 'provider: github');

  // --- скрытое обновление: staging не должен содержать путей *.asar ---
  // Electron перехватывает такие пути в fs и ломает rm/rename, поэтому
  // скачанный архив хранится как update.bin.
  if (process.platform === 'win32') {
    const installRoot = path.join(tempRoot, 'install');
    fs.mkdirSync(path.join(installRoot, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'resources', 'app.asar'), 'old');
    const originalAppPath = fakeElectron.app.getAppPath;
    fakeElectron.app.getAppPath = () => path.join(installRoot, 'resources', 'app.asar');

    const asarBody = Buffer.from('fake-asar-bytes');
    const asarServer = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Length': asarBody.length });
      response.end(asarBody);
    });
    await new Promise((resolve) => asarServer.listen(0, '127.0.0.1', resolve));
    try {
      const update = await prepareUpdate({
        version: '9.9.9',
        assetUrl: `http://127.0.0.1:${asarServer.address().port}/app-9.9.9.asar`,
        assetName: 'app-9.9.9.asar',
        assetSize: asarBody.length,
        asarAsset: true,
      });
      assert.equal(path.basename(update.stagedAsar), 'update.bin');
      assert.equal(fs.readFileSync(update.stagedAsar, 'utf8'), 'fake-asar-bytes');
      assert.equal(update.stagedSha256, sha256(asarBody));
      assert.equal(update.version, '9.9.9');
      assert.equal(fs.existsSync(path.join(update.extracted, 'app.asar')), false);
      // Повторный запуск должен успешно очистить staging и не падать.
      const again = await prepareUpdate({
        version: '9.9.9',
        assetUrl: `http://127.0.0.1:${asarServer.address().port}/app-9.9.9.asar`,
        assetName: 'app-9.9.9.asar',
        assetSize: asarBody.length,
        asarAsset: true,
      });
      assert.equal(fs.readFileSync(again.stagedAsar, 'utf8'), 'fake-asar-bytes');
      assert.equal(again.stagedSha256, sha256(asarBody));
    } finally {
      asarServer.close();
      fakeElectron.app.getAppPath = originalAppPath;
    }
  }

  // --- скрипт обновления проверяет SHA256 и пишет результат ---
  const applyDir = path.join(tempRoot, 'apply-script');
  fs.mkdirSync(applyDir, { recursive: true });
  const applyScript = writeApplyScript({
    staging: applyDir,
    appDir: path.join(tempRoot, 'install'),
    stagedAsar: path.join(tempRoot, 'staged-update.bin'),
    stagedSha256: 'abc123',
    version: '9.9.9',
    logFile: path.join(tempRoot, 'update.log'),
    resultFile: path.join(tempRoot, 'update-result.json'),
  });
  const applyText = fs.readFileSync(applyScript, 'utf8');
  assert.match(applyText, /Get-FileHash/);
  assert.match(applyText, /abc123/);
  assert.match(applyText, /Скрипт запущен/);

  // --- неудачное обновление видно следующему запуску ---
  const resultFile = path.join(tempRoot, 'userData', 'update-result.json');
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false, version: '9.9.9', message: 'тест' }));
  const taken = takeUpdateResult();
  assert.equal(taken.ok, false);
  assert.equal(taken.version, '9.9.9');
  assert.equal(fs.existsSync(resultFile), false);
  assert.equal(takeUpdateResult(), null);

  // --- ченджлог сборки: репозиторий и тег берутся из ссылок релиза ---
  assert.deepEqual(
    packReleaseSource({
      archive: {
        url: 'https://github.com/SnikersFeed/modpacks/releases/download/atmons-1.3.0-v1/pack.zip',
      },
      files: [],
    }),
    { repo: 'SnikersFeed/modpacks', tag: 'atmons-1.3.0-v1' }
  );
  assert.deepEqual(
    packReleaseSource({
      archive: null,
      files: [{ url: 'https://github.com/o/r/releases/download/pack-v2/file.json' }],
    }),
    { repo: 'o/r', tag: 'pack-v2' }
  );
  assert.equal(packReleaseSource({ archive: null, files: [] }), null);

  // --- рекомендуемая память ---
  assert.equal(recommendedMemoryMb({ minMb: 2048, maxMb: 8192, recommended: '6G' }), 6144);
  assert.equal(recommendedMemoryMb({ recommendedMb: 5120 }), 5120);
  assert.equal(recommendedMemoryMb({ minMb: 2048, maxMb: 4096 }), null);
  assert.equal(recommendedMemoryMb(undefined), null);

  // --- статус установленной сборки, логотип и удаление ---
  const statusPack = normalizePack(
    {
      id: 'status-pack',
      minecraft: '1.20.1',
      loader: { type: 'vanilla' },
      files: [
        { path: 'mods/a.jar', sha1: sha1('a'), size: 1 },
        { path: 'config/fancymenu/assets/logo.png', sha1: sha1('logo'), size: 4 },
      ],
    },
    'https://example.com/packs/status-pack/pack.json'
  );

  const fresh = await packStatus(statusPack);
  assert.equal(fresh.installed, false);
  assert.equal(fresh.updateAvailable, false);

  const statusDir = path.join(tempRoot, 'userData', 'data', 'instances', 'status-pack');
  fs.mkdirSync(path.join(statusDir, '.launcher'), { recursive: true });
  fs.mkdirSync(path.join(statusDir, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(statusDir, 'config', 'fancymenu', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(statusDir, 'mods/a.jar'), 'a');
  // 1x1 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(path.join(statusDir, 'config/fancymenu/assets/logo.png'), png);
  fs.writeFileSync(
    path.join(statusDir, '.launcher/state.json'),
    JSON.stringify({ version: 1, files: { 'mods/a.jar': sha1('a') } })
  );

  const partial = await packStatus(statusPack);
  assert.equal(partial.installed, true);
  assert.equal(partial.updateAvailable, true);
  assert.equal(partial.pending, 1);

  const logo = await packLogo(statusPack);
  assert.ok(logo && logo.startsWith('data:image/png;base64,'), 'логотип FancyMenu должен читаться');

  await deletePack(statusPack.id);
  assert.equal(fs.existsSync(statusDir), false);
  assert.equal((await packStatus(statusPack)).installed, false);

  // --- автоустановка Java: нужная версия выбирается без скачивания ---
  const { ensureJava } = require('../src/main/minecraft');
  const local = await ensureJava(8, '', { allowDownload: false }).catch(() => null);
  if (local) {
    assert.ok(local.majorVersion >= 8);
    assert.ok(local.path);
  }

  server.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log('OK: все smoke-тесты прошли');
}

main().catch((error) => {
  console.error(error);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(1);
});
