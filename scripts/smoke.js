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
const { normalizePack, sanitizeRelativePath, toMegabytes } = require('../src/main/packs');
const { syncInstance } = require('../src/main/sync');
const { offlineUuid, requiredJavaMajor, parseJavaVersionText } = require('../src/main/minecraft');
const { isNewer } = require('../src/main/updater');

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
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

  // --- сервер с архивами ---
  const v1 = makeZip({ 'mods/a.jar': 'v1', 'config/test.txt': 'cfg' });
  const v2 = makeZip({ 'mods/a.jar': 'v2', 'mods/b.jar': 'new' });

  let currentArchive = v1.buffer;
  const server = http.createServer((request, response) => {
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
