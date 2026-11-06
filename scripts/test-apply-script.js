'use strict';

// Проверяет скрипт применения обновления на копии установленной папки:
// запускает процесс-«лаунчер», генерирует apply-update.ps1, завершает процесс,
// ждёт подмену app.asar. Запуск: node scripts/test-apply-script.js

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Module = require('node:module');

const root = path.join(process.env.TEMP || '.', 'smc-apply-test');
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Прошлый запуск ещё не завершил перезапущенный процесс — чистим, что сможем.
  try {
    require('node:child_process').spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "Get-Process SimpleMCLauncher -ErrorAction SilentlyContinue | Stop-Process -Force",
    ]);
    require('node:child_process').spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Sleep -Milliseconds 800; Remove-Item -LiteralPath '${root}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ]);
  } catch {}
}

const appDir = path.join(root, 'app');
fs.mkdirSync(path.join(appDir, 'resources'), { recursive: true });
fs.writeFileSync(path.join(appDir, 'resources', 'app.asar'), 'OLD');

// Заглушка вместо .exe: отдельный node-процесс, который просто «живёт».
const exe = process.execPath;
const fakeAliveScript = path.join(root, 'alive.js');
fs.writeFileSync(fakeAliveScript, 'setInterval(() => {}, 1000);');

const fakeElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? path.join(root, 'userData') : root),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.0.0',
    quit: () => {},
  },
  shell: { openPath: async () => '' },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { prepareUpdate, applyUpdateAndRestart } = require('../src/main/updater');

  const fakeInstaller = path.join(root, 'update.zip');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('app.asar', Buffer.from('NEW'));
  zip.addFile('app-update.yml', Buffer.from('owner: test'));
  zip.writeZip(fakeInstaller);

  // Подменяем process.execPath на exe рядом с appDir.
  Object.defineProperty(process, 'execPath', { value: path.join(appDir, 'SimpleMCLauncher.exe') });
  fs.copyFileSync(exe, path.join(appDir, 'SimpleMCLauncher.exe'));
  // Перезапуск запускает именно этот exe — обёртка, которая просто живёт.
  fs.copyFileSync(fakeAliveScript, path.join(appDir, 'src-alive.js'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'fake-launcher', main: 'src-alive.js' }));

  const server = require('node:http').createServer((_req, res) => {
    const body = fs.readFileSync(fakeInstaller);
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const update = await prepareUpdate({
    version: '9.9.9',
    assetUrl: `http://127.0.0.1:${port}/update.zip`,
    assetName: 'update.zip',
    assetSize: 0,
  });
  server.close();

  // «Лаунчер» — процесс, чей pid записывается в скрипт.
  let alive = spawn(exe, [fakeAliveScript], { detached: true, stdio: 'ignore' });
  Object.defineProperty(process, 'pid', { value: alive.pid });

  const result = await applyUpdateAndRestart(update);
  console.log('apply result:', result, 'script:', fs.existsSync(path.join(result.staging, 'apply-update.ps1')));
  alive.kill();
  console.log('staging:', result.staging);

  // Ждём подмену файла.
  const target = path.join(appDir, 'resources', 'app.asar');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (fs.readFileSync(target, 'utf8') === 'NEW') break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const content = fs.readFileSync(target, 'utf8');
  const yml = fs.existsSync(path.join(appDir, 'resources', 'app-update.yml'))
    ? fs.readFileSync(path.join(appDir, 'resources', 'app-update.yml'), 'utf8')
    : '(нет)';

  console.log('app.asar after restart:', content);
  console.log('app-update.yml after restart:', yml);
  if (fs.existsSync(path.join(result.staging, 'apply.log'))) {
    console.log('--- apply.log ---\n' + fs.readFileSync(path.join(result.staging, 'apply.log'), 'utf8'));
  }

  // Даём скрипту закончить перезапуск.
  await new Promise((r) => setTimeout(r, 2000));

  // Убиваем перезапущенный лаунчер и чистим.
  spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Process SimpleMCLauncher -ErrorAction SilentlyContinue | Stop-Process -Force"]);
  await new Promise((r) => setTimeout(r, 1500));
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.log('cleanup skipped:', error.code);
  }
  fs.rmSync(path.join(process.env.TEMP || '.', 'smc-update-flow'), { recursive: true, force: true });

  if (content !== 'NEW' || yml !== 'owner: test') {
    console.error('FAIL: обновление не применилось');
    process.exit(1);
  }
  console.log('OK: app.asar заменён, лаунчер перезапущен');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
