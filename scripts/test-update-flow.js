'use strict';

// Ручная проверка prepareUpdate: скачивает настоящий установщик по локальному HTTP
// и готовит app.asar рядом с установленной копией. Запуск: node scripts/test-update-flow.js

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const Module = require('node:module');
const tempRoot = path.join(process.env.TEMP || '.', 'smc-update-flow');
const appDir = path.join(process.cwd(), 'dist', 'win-unpacked');

const fakeElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? path.join(tempRoot, 'userData') : tempRoot),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.0.0',
    quit: () => {},
  },
  shell: { openPath: async () => '', openExternal: async () => {} },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const installer = path.join(process.cwd(), 'dist', 'SimpleMCLauncher-Setup-1.0.0.exe');
const originalExecPath = process.execPath;

async function main() {
  const server = http.createServer((_request, response) => {
    const stat = fs.statSync(installer);
    response.writeHead(200, { 'Content-Length': stat.size });
    fs.createReadStream(installer).pipe(response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // prepareUpdate смотрит на process.execPath/resources/app.asar
  Object.defineProperty(process, 'execPath', { value: path.join(appDir, 'SimpleMCLauncher.exe') });

  const { prepareUpdate } = require('../src/main/updater');

  let lastPercent = 0;
  const started = Date.now();
  const result = await prepareUpdate(
    {
      version: '9.9.9',
      assetUrl: `http://127.0.0.1:${port}/SimpleMCLauncher-Setup-1.0.0.exe`,
      assetName: 'SimpleMCLauncher-Setup-1.0.0.exe',
      assetSize: fs.statSync(installer).size,
    },
    {
      onStatus: (msg) => console.log('status:', msg),
      onProgress: ({ percent }) => {
        if (percent !== null && percent - lastPercent >= 20) {
          lastPercent = percent;
          console.log(`progress: ${Math.round(percent)}%`);
        }
      },
    }
  );

  console.log('elapsed ms:', Date.now() - started);
  console.log('stagedAsar:', result.stagedAsar, fs.statSync(result.stagedAsar).size);
  console.log('stagedUpdateYml:', result.stagedUpdateYml);
  console.log('appDir:', result.appDir);

  const head = fs.readFileSync(result.stagedAsar).subarray(0, 8).toString('hex');
  console.log('asar header:', head, head.startsWith('04000000') ? '(OK)' : '(неожиданный заголовок!)');

  server.close();
  Object.defineProperty(process, 'execPath', { value: originalExecPath });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
