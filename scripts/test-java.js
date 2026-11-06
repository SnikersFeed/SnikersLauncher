'use strict';

// Проверяет реальную автоустановку Java от Mojang. Запуск: node scripts/test-java.js [21]
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const tempRoot = path.join(process.env.TEMP || '.', 'smc-java-test');
const fakeElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? path.join(tempRoot, 'userData') : tempRoot),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.0.0',
    quit: () => {},
  },
  shell: {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  findJavaInstalls,
  ensureJava,
  installMojangRuntime,
  readJavaInfo,
} = require('../src/main/minecraft');

async function main() {
  const major = Number(process.argv[2] || 21);

  const before = await findJavaInstalls();
  console.log('найдено Java:', before.map((i) => `${i.majorVersion} ${i.path}`).join(' | ') || '—');

  let last = '';
  const started = Date.now();
  const javaPath = await installMojangRuntime(major, (message) => {
    if (message !== last) {
      last = message;
      console.log(message);
    }
  });

  console.log('elapsed ms:', Date.now() - started);
  console.log('java path:', javaPath);
  if (!javaPath) {
    console.error('FAIL: runtime не установлен');
    process.exit(1);
  }

  const info = await readJavaInfo(javaPath);
  console.log('version:', info && `${info.majorVersion} ${info.version}`);
  if (!info || info.majorVersion < major) {
    console.error('FAIL: установленная Java не подходит');
    process.exit(1);
  }

  console.log('OK: Java', major, 'установлена автоматически');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
