'use strict';

const fs = require('node:fs');
const { ipcMain, BrowserWindow, dialog, shell, app } = require('electron');

const { getConfig, setUserConfig } = require('./config');
const { listPacks, getPack } = require('./packs');
const { syncInstance } = require('./sync');
const { play, stop, isRunning } = require('./minecraft');
const { checkForUpdate, downloadAndInstallUpdate } = require('./updater');
const { instanceDir } = require('./paths');

function getWindow() {
  return BrowserWindow.getAllWindows()[0] || null;
}

function send(channel, payload) {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function validateNickname(input) {
  const nickname = String(input || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nickname)) {
    throw new Error('Никнейм: 3–16 символов, только латиница, цифры и подчёркивание');
  }
  return nickname;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle('config:get', () => ({
    ...getConfig(),
    appVersion: app.getVersion(),
  }));

  ipcMain.handle('config:set', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return getConfig();
    const allowed = ['nickname', 'selectedPack', 'javaPath', 'maxMemoryMb'];
    const safePatch = {};

    for (const key of allowed) {
      if (key in patch) safePatch[key] = patch[key];
    }

    if ('maxMemoryMb' in safePatch) {
      const value = Number(safePatch.maxMemoryMb);
      safePatch.maxMemoryMb = Number.isFinite(value)
        ? Math.min(Math.max(Math.round(value), 1024), 65536)
        : undefined;
      if (safePatch.maxMemoryMb === undefined) delete safePatch.maxMemoryMb;
    }

    return setUserConfig(safePatch);
  });

  ipcMain.handle('packs:list', () => listPacks());

  ipcMain.handle('packs:get', async (_event, id) => getPack(id));

  ipcMain.handle('instance:open', async (_event, id) => {
    const directory = instanceDir(id);
    await fs.promises.mkdir(directory, { recursive: true });
    await shell.openPath(directory);
    return directory;
  });

  ipcMain.handle('dialog:pick-java', async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window, {
      title: 'Выберите java.exe',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java', extensions: ['exe'] }]
          : [{ name: 'Все файлы', extensions: ['*'] }],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('game:play', async (_event, payload = {}) => {
    if (isRunning()) throw new Error('Игра уже запущена');

    const nickname = validateNickname(payload.nickname);
    const pack = await getPack(payload.packId);

    const config = getConfig();
    const requestedMemory =
      Number(payload.maxMemoryMb) || Number(config.maxMemoryMb) || pack.memory.maxMb;
    const maxMemoryMb = Math.min(Math.max(Math.round(requestedMemory), 1024), 65536);
    const minMemoryMb = Math.min(pack.memory.minMb, maxMemoryMb);

    setUserConfig({
      nickname,
      selectedPack: pack.id,
      maxMemoryMb,
    });

    // Сначала синхронизируем файлы сборки, затем ставим и запускаем игру.
    const syncResult = await syncInstance(pack, {
      onStatus: (message) => send('status', message),
      onProgress: (progress) => send('progress', progress),
    });

    send('status', 'Подготовка Minecraft…');
    send('progress', { percent: null, label: 'Подготовка Minecraft…' });

    const result = await play({
      pack,
      nickname,
      javaPath: payload.javaPath || config.javaPath || '',
      memory: { minMb: minMemoryMb, maxMb: maxMemoryMb },
      onStatus: (message) => send('status', message),
      onLog: (stream, text) => send('log', { stream, text }),
      onExit: (event) => send('game:exit', event),
    });

    return { ...result, directory: syncResult.directory, updatedFiles: syncResult.updated };
  });

  ipcMain.handle('game:stop', () => stop());

  ipcMain.handle('launcher:check-update', async () => {
    try {
      return await checkForUpdate();
    } catch (error) {
      console.warn('Проверка обновления лаунчера не удалась:', error.message);
      return null;
    }
  });

  ipcMain.handle('launcher:install-update', async (_event, info) => {
    return downloadAndInstallUpdate(info, {
      onProgress: (progress) => send('update:progress', progress),
    });
  });
}

module.exports = {
  registerIpc,
  send,
};
