'use strict';

const path = require('node:path');
const { app } = require('electron');

const dataRoot = path.join(app.getPath('userData'), 'data');

/** Допустимые символы в id сборки — защита от выхода за пределы папки. */
function safeId(id) {
  const value = String(id || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Недопустимый идентификатор сборки: ${id}`);
  }
  return value;
}

function instanceDir(id) {
  return path.join(dataRoot, 'instances', safeId(id));
}

module.exports = {
  dataRoot,
  minecraftDir: path.join(dataRoot, 'minecraft'),
  instancesDir: path.join(dataRoot, 'instances'),
  cacheDir: path.join(dataRoot, 'cache'),
  instanceDir,
  safeId,
};
