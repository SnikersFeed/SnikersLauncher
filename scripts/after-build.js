'use strict';

/**
 * electron-builder hook: после сборки копирует app.asar рядом с установщиком,
 * чтобы он попал в релиз и лаунчер мог обновиться скрыто, без запуска установщика.
 */

const fs = require('node:fs');
const path = require('node:path');

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

module.exports = async function afterBuild(buildResult) {
  // Контекст хука: { outDir, appOutDir, packager }.
  const outputDir = buildResult.outDir;
  const appOutDir = buildResult.appOutDir || path.join(outputDir, 'win-unpacked');
  const source = path.join(appOutDir, 'resources', 'app.asar');

  if (!fs.existsSync(source)) {
    console.warn(`[after-build] app.asar не найден: ${source}`);
    return [];
  }

  const version = readVersion();
  const target = path.join(outputDir, `app-${version}.asar`);
  fs.copyFileSync(source, target);

  console.log(`[after-build] добавил ${path.basename(target)} для скрытого обновления`);
  return [target];
};
