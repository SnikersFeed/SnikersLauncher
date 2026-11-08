'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('launcher', {
  info: () => ipcRenderer.invoke('app:info'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  serverStatus: () => ipcRenderer.invoke('server:status'),

  listPacks: () => ipcRenderer.invoke('packs:list'),
  getPack: (id) => ipcRenderer.invoke('packs:get', id),
  openInstance: (id) => ipcRenderer.invoke('instance:open', id),

  pickJava: () => ipcRenderer.invoke('dialog:pick-java'),
  play: (payload) => ipcRenderer.invoke('game:play', payload),
  stop: () => ipcRenderer.invoke('game:stop'),

  checkUpdate: () => ipcRenderer.invoke('launcher:check-update'),
  installUpdate: (info) => ipcRenderer.invoke('launcher:install-update', info),
  launcherChangelog: () => ipcRenderer.invoke('changelog:launcher'),
  packChangelog: (id) => ipcRenderer.invoke('changelog:pack', id),

  packStatus: (id) => ipcRenderer.invoke('packs:status', id),
  packLogo: (id) => ipcRenderer.invoke('packs:logo', id),
  deletePack: (id) => ipcRenderer.invoke('packs:delete', id),

  onStatus: (callback) => subscribe('status', callback),
  onProgress: (callback) => subscribe('progress', callback),
  onLog: (callback) => subscribe('log', callback),
  onGameExit: (callback) => subscribe('game:exit', callback),
  onUpdateAvailable: (callback) => subscribe('update:available', callback),
  onUpdateProgress: (callback) => subscribe('update:progress', callback),
  onUpdateStatus: (callback) => subscribe('update:status', callback),
});
