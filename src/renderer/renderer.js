'use strict';

const api = window.launcher;
const el = (id) => document.getElementById(id);

const state = {
  config: null,
  packs: [],
  pack: null,
  busy: false,
  running: false,
  exitCount: 0,
  update: null,
  updateBusy: false,
  updateFailed: false,
  packStatus: null,
  packLogo: null,
};

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

// Номер последнего выбора сборки: ответы на устаревшие запросы игнорируем.
let selectToken = 0;

function errorMessage(error) {
  return String(error?.message || error)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

const ERROR_HINT =
  'Попробуйте перезапустить лаунчер. Если не помогает — обратитесь к разработчику.';

function withHint(message) {
  const text = String(message);
  return text.includes('перезапустить лаунчер') ? text : `${text}\n\n${ERROR_HINT}`;
}

function showError(message, hint = true) {
  const box = el('errorBox');
  box.classList.remove('notice');
  box.textContent = hint ? withHint(message) : String(message);
  box.classList.remove('hidden');
}

function showNotice(message) {
  const box = el('errorBox');
  box.classList.add('notice');
  box.textContent = message;
  box.classList.remove('hidden');
}

function hideError() {
  const box = el('errorBox');
  box.classList.add('hidden');
  box.classList.remove('notice');
  box.textContent = '';
}

function appendLog(stream, text) {
  const output = el('logOutput');
  const clean = String(text || '').replace(ANSI_RE, '');

  for (const line of clean.split(/\r?\n/)) {
    if (!line.trim()) continue;
    output.textContent += `[${stream}] ${line}\n`;
  }

  const lines = output.textContent.split('\n');
  if (lines.length > 700) {
    output.textContent = lines.slice(-700).join('\n');
  }

  if (output.parentElement.open) {
    output.scrollTop = output.scrollHeight;
  }
}

function setProgress(percent, label) {
  el('progressWrap').classList.remove('hidden');
  const bar = el('progressBar');
  const known = typeof percent === 'number' && Number.isFinite(percent);

  if (known) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    el('progressPercent').textContent = `${Math.round(percent)}%`;
  } else {
    bar.classList.add('indeterminate');
    bar.style.width = '';
    el('progressPercent').textContent = '';
  }

  if (label) el('status').textContent = label;
}

function loaderLabel(loader) {
  if (!loader || loader.type === 'vanilla') return 'Vanilla';
  const names = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
  return `${names[loader.type] || loader.type}${loader.version ? ` ${loader.version}` : ''}`;
}

function loaderIcon(loader) {
  if (!loader || loader.type === 'vanilla') return '⛏';
  if (loader.type === 'fabric') return '🧵';
  if (loader.type === 'forge') return '🔥';
  if (loader.type === 'neoforge') return '⚙️';
  return '📦';
}

function renderPack(pack) {
  el('packName').textContent = pack.name;
  el('packDescription').textContent = pack.description || 'Без описания';
  renderIcon(pack);

  const tags = el('packTags');
  tags.innerHTML = '';

  const recommended = pack.recommendedMemoryMb
    ? `Рекомендуется ${Math.round(pack.recommendedMemoryMb / 1024)} ГБ`
    : `RAM до ${Math.round(pack.memory.maxMb / 1024)} ГБ`;

  const values = [
    { text: `Minecraft ${pack.minecraft}`, accent: true },
    { text: loaderLabel(pack.loader) },
    { text: `Java ${pack.java || '—'}` },
    { text: `RAM ${recommended}` },
  ];

  for (const value of values) {
    const tag = document.createElement('span');
    tag.className = `tag${value.accent ? ' accent' : ''}`;
    tag.textContent = value.text;
    tags.appendChild(tag);
  }

  updateButtons();
}

function renderIcon(pack) {
  const icon = el('packIcon');
  icon.innerHTML = '';
  icon.classList.remove('has-logo');

  if (state.packLogo) {
    const img = document.createElement('img');
    img.src = state.packLogo;
    img.alt = pack.name;
    icon.appendChild(img);
    icon.classList.add('has-logo');
    return;
  }

  icon.textContent = loaderIcon(pack.loader);
}

/** Статус выбранной сборки: индикатор обновления и кнопка удаления. */
async function refreshPackStatus() {
  const pack = state.pack;
  if (!pack) return;

  let status = { installed: false, updateAvailable: false };
  try {
    status = await api.packStatus(pack.id);
  } catch {
    // статус не критичен для запуска
  }

  // Пока запрос летел, пользователь мог выбрать другую сборку.
  if (state.pack !== pack) return;

  state.packStatus = status;

  const dot = el('packUpdateDot');
  dot.classList.toggle('on', Boolean(status.updateAvailable));
  dot.title = status.updateAvailable
    ? `Доступно обновление сборки (${status.pending} файлов)`
    : 'Сборка актуальна';

  el('deleteBtn').classList.toggle('hidden', !status.installed);
  el('deleteBtn').disabled = state.busy || state.running;

  if (status.updateAvailable) {
    appendLog('launcher', `Для "${pack.name}" есть обновление: ${status.pending} файлов`);
  }
}

async function loadPackLogo(pack) {
  let logo = null;

  try {
    logo = await api.packLogo(pack.id);
  } catch {
    logo = null;
  }

  // Логотип устаревшей сборки не должен перетирать текущий.
  if (!state.pack || state.pack.id !== pack.id) return;

  state.packLogo = logo;
  renderIcon(state.pack);
}

async function refreshServerStatus() {
  const pill = el('serverStatus');

  if (!state.config?.server) {
    pill.classList.add('hidden');
    return;
  }

  let status;
  try {
    status = await api.serverStatus();
  } catch {
    pill.classList.add('hidden');
    return;
  }

  if (!status.configured) {
    pill.classList.add('hidden');
    return;
  }

  pill.classList.remove('hidden');
  pill.classList.toggle('online', Boolean(status.online));
  pill.classList.toggle('offline', !status.online);

  if (status.online) {
    el('serverLabel').textContent =
      `Сервер: онлайн · ${status.players.online}/${status.players.max}`;
    pill.title = `${status.address}\n${status.motd || ''}\nЗадержка: ${status.latency} мс`;
  } else {
    el('serverLabel').textContent = 'Сервер: офлайн';
    pill.title = `${status.address}\n${status.error || 'Нет ответа'}`;
  }
}

function updateButtons() {
  const active = state.running;
  const busy = state.busy;

  el('playBtn').classList.toggle('hidden', active);
  el('stopBtn').classList.toggle('hidden', !active);
  el('playBtn').disabled = active || busy || !state.pack;
  el('playLabel').textContent = busy ? 'Подготовка…' : 'Играть';
  el('folderBtn').disabled = !state.pack;
  el('deleteBtn').disabled = active || busy || !state.packStatus?.installed;
  el('packSelect').disabled = active || busy;
  el('nickname').disabled = active || busy;
}

async function selectPack(id) {
  const token = ++selectToken;

  // Пока грузится pack.json (может быть ~1 МБ), Play должен быть выключен:
  // иначе он запустит предыдущую сборку из state.pack.
  state.busy = true;
  updateButtons();

  try {
    const pack = await api.getPack(id);
    if (token !== selectToken) return;

    state.pack = pack;
    state.packStatus = null;
    renderPack(pack);
    el('packUpdateDot').classList.remove('on');
    el('deleteBtn').classList.add('hidden');
    await api.setConfig({ selectedPack: pack.id });

    await Promise.all([refreshPackStatus(), loadPackLogo(pack)]);
  } catch (error) {
    if (token !== selectToken) return;
    showError(errorMessage(error));
    // Список возвращаем к сборке, которая реально загружена.
    if (state.pack) el('packSelect').value = state.pack.id;
  } finally {
    if (token === selectToken) {
      state.busy = false;
      updateButtons();
    }
  }
}

async function loadPacks() {
  const result = await api.listPacks();
  state.packs = result.packs || [];

  const select = el('packSelect');
  select.innerHTML = '';

  for (const pack of state.packs) {
    const option = document.createElement('option');
    option.value = pack.id;
    option.textContent = pack.name;
    select.appendChild(option);
  }

  if (result.error) {
    const message = `Не удалось загрузить сборки с GitHub:\n${result.error}`;
    if (result.demo) {
      showNotice(`Демо-режим. ${result.error}`);
    } else {
      showError(message);
    }
  }

  if (state.packs.length === 0) {
    el('packName').textContent = 'Нет доступных сборок';
    el('packDescription').textContent = 'Добавьте сборки в manifest.json своего репозитория.';
    updateButtons();
    return;
  }

  const saved = state.packs.find((pack) => pack.id === state.config.selectedPack);
  const selected = saved || state.packs[0];

  select.value = selected.id;
  await selectPack(selected.id);
}

async function onPlay() {
  if (state.running || state.busy || !state.pack) return;

  hideError();

  const nickname = el('nickname').value.trim();
  if (!NICK_RE.test(nickname)) {
    showError('Никнейм: 3–16 символов, только латиница, цифры и подчёркивание.', false);
    el('nickname').focus();
    return;
  }

  const exitCount = state.exitCount;
  state.busy = true;
  state.running = false;
  updateButtons();
  setProgress(null, 'Подготовка…');
  appendLog('launcher', `Запуск сборки "${state.pack.name}" под ником ${nickname}`);

  try {
    // Память берётся только из настроек лаунчера; рекомендацию сборки
    // берём, если пользователь ничего не задал.
    const maxMemoryMb =
      Number(state.config.maxMemoryMb) || state.pack.recommendedMemoryMb || undefined;

    const result = await api.play({
      packId: state.pack.id,
      nickname,
      javaPath: state.config.javaPath || '',
      maxMemoryMb,
    });

    state.busy = false;
    // Игра могла успеть закрыться до того, как play() вернул управление.
    state.running = state.exitCount === exitCount;
    updateButtons();

    appendLog('launcher', `Minecraft запущен (PID ${result.pid})`);
    setProgress(100, 'Игра запущена');
    refreshPackStatus().catch(() => {});
  } catch (error) {
    state.busy = false;
    state.running = false;
    updateButtons();
    setProgress(0, 'Ошибка запуска');
    showError(errorMessage(error));
    appendLog('launcher', `Ошибка: ${errorMessage(error)}`);
  }
}

async function onStop() {
  try {
    await api.stop();
    el('status').textContent = 'Остановка Minecraft…';
  } catch (error) {
    showError(errorMessage(error));
  }
}

function showUpdate(info) {
  state.update = info;
  if (state.updateBusy) return;
  el('updateBtn').classList.remove('hidden');
  el('updateLabel').textContent = state.updateFailed
    ? `Скачать ${info.version} вручную`
    : `Обновить до ${info.version}`;
  appendLog('launcher', `Доступно обновление лаунчера ${info.version}`);
}

async function onUpdateClick() {
  if (!state.update || state.updateBusy) return;

  // Тихая установка не удалась — ведём на страницу последнего релиза.
  if (state.updateFailed) {
    window.open(state.update.releaseUrl, '_blank');
    return;
  }

  if (!state.update.assetUrl) {
    window.open(state.update.releaseUrl, '_blank');
    return;
  }

  state.updateBusy = true;
  hideError();
  el('updateBtn').classList.add('hidden');
  setProgress(null, 'Подготовка обновления лаунчера…');

  try {
    const installed = await api.installUpdate(state.update);
    if (installed?.manual) {
      state.updateBusy = false;
      el('updateBtn').classList.remove('hidden');
      setProgress(0, 'Открыт установщик обновления');
      return;
    }
    setProgress(100, 'Обновление установлено, перезапуск…');
  } catch (error) {
    state.updateBusy = false;
    state.updateFailed = true;
    el('updateBtn').classList.remove('hidden');
    el('updateLabel').textContent = `Скачать ${state.update.version} вручную`;
    setProgress(0, 'Ошибка обновления');
    showError(errorMessage(error));
  }
}

async function checkUpdate(manual = false) {
  try {
    const info = await api.checkUpdate();
    if (info) {
      showUpdate(info);
      if (manual) setProgress(null, `Доступно обновление ${info.version}`);
    } else if (manual) {
      setProgress(100, 'Установлена последняя версия');
    }
  } catch (error) {
    if (manual) showError(errorMessage(error));
  }
}

function openSettings() {
  el('memory').value = state.config.maxMemoryMb || '';

  const recommended = state.pack?.recommendedMemoryMb;
  el('memory').placeholder = recommended ? String(recommended) : 'Автоматически';
  el('memoryHint').textContent = recommended
    ? `Сборка "${state.pack.name}" рекомендует ${Math.round(recommended / 1024)} ГБ ` +
      `(${recommended} МБ). Если оставить поле пустым, будет использоваться это значение.`
    : 'Если оставить поле пустым, лаунчер выберет объём автоматически.';

  el('javaPath').value = state.config.javaPath || '';
  el('hideWhilePlaying').checked = state.config.hideWhilePlaying !== false;
  el('settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const maxMemoryMb = Number(el('memory').value) || undefined;
  const javaPath = el('javaPath').value.trim();
  const hideWhilePlaying = el('hideWhilePlaying').checked;

  state.config = await api.setConfig({ maxMemoryMb, javaPath, hideWhilePlaying });
  el('settingsModal').classList.add('hidden');
  appendLog(
    'launcher',
    maxMemoryMb
      ? `Память для игры: ${maxMemoryMb} МБ`
      : 'Память будет выбрана автоматически по рекомендации сборки'
  );
}

function openDeleteDialog() {
  const pack = state.pack;
  if (!pack || !state.packStatus?.installed || state.busy || state.running) return;

  el('deleteText').textContent =
    `Папка сборки "${pack.name}" будет удалена вместе с изменениями и сохранениями ` +
    'внутри неё. Общие файлы Minecraft и другие сборки останутся на месте.';
  el('deleteModal').classList.remove('hidden');
}

async function confirmDelete() {
  const pack = state.pack;
  el('deleteModal').classList.add('hidden');
  if (!pack) return;

  try {
    await api.deletePack(pack.id);
    appendLog('launcher', `Сборка "${pack.name}" удалена`);
    showNotice(`Сборка "${pack.name}" удалена. Установите её снова кнопкой «Играть».`);
    await refreshPackStatus();
  } catch (error) {
    showError(errorMessage(error));
  }
}

function formatReleaseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-RU');
}

function renderChangelog(releases, currentVersion) {
  const body = el('changelogBody');
  body.innerHTML = '';

  if (!releases.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Изменения не найдены.';
    body.appendChild(empty);
    return;
  }

  for (const release of releases) {
    const item = document.createElement('article');
    item.className = 'changelog-item';

    const head = document.createElement('div');
    head.className = 'changelog-item-head';

    const title = document.createElement('strong');
    title.textContent = `v${release.version}`;
    head.appendChild(title);

    if (currentVersion && release.version === currentVersion) {
      const badge = document.createElement('span');
      badge.className = 'changelog-badge';
      badge.textContent = 'установлено';
      head.appendChild(badge);
    }

    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = [release.name !== `v${release.version}` ? release.name : '', formatReleaseDate(release.publishedAt)]
      .filter(Boolean)
      .join(' · ');
    if (meta.textContent) head.appendChild(meta);

    const notes = document.createElement('div');
    notes.className = 'changelog-notes';
    notes.textContent = release.notes || 'Без описания.';

    item.append(head, notes);
    body.appendChild(item);
  }
}

async function openChangelog(kind) {
  const pack = state.pack;
  el('changelogTitle').textContent =
    kind === 'pack'
      ? `Что нового в сборке${pack ? ` «${pack.name}»` : ''}`
      : 'Что нового в лаунчере';

  const body = el('changelogBody');
  body.textContent = 'Загрузка…';
  el('changelogModal').classList.remove('hidden');

  try {
    const releases =
      kind === 'pack'
        ? pack
          ? await api.packChangelog(pack.id)
          : []
        : await api.launcherChangelog();
    renderChangelog(releases, kind === 'launcher' ? state.config?.appVersion : null);
  } catch (error) {
    body.textContent = withHint(`Не удалось загрузить ченджлог: ${errorMessage(error)}`);
  }
}

function bindEvents() {
  el('playBtn').addEventListener('click', onPlay);
  el('stopBtn').addEventListener('click', onStop);
  el('folderBtn').addEventListener('click', () => {
    if (state.pack) api.openInstance(state.pack.id).catch((error) => showError(errorMessage(error)));
  });

  el('packSelect').addEventListener('change', (event) => selectPack(event.target.value));

  el('nickname').addEventListener('change', () => {
    api.setConfig({ nickname: el('nickname').value.trim() }).catch(() => {});
  });

  el('settingsBtn').addEventListener('click', openSettings);
  el('settingsCloseIcon').addEventListener('click', () => el('settingsModal').classList.add('hidden'));
  el('settingsSave').addEventListener('click', () => saveSettings().catch((error) => showError(errorMessage(error))));

  el('pickJavaBtn').addEventListener('click', async () => {
    const picked = await api.pickJava();
    if (picked) el('javaPath').value = picked;
  });

  el('settingsModal').addEventListener('click', (event) => {
    if (event.target === el('settingsModal')) el('settingsModal').classList.add('hidden');
  });

  el('deleteBtn').addEventListener('click', openDeleteDialog);
  el('deleteCancel').addEventListener('click', () => el('deleteModal').classList.add('hidden'));
  el('deleteCloseIcon').addEventListener('click', () => el('deleteModal').classList.add('hidden'));
  el('deleteConfirm').addEventListener('click', () => confirmDelete());
  el('deleteModal').addEventListener('click', (event) => {
    if (event.target === el('deleteModal')) el('deleteModal').classList.add('hidden');
  });

  el('packChangelogBtn').addEventListener('click', () => openChangelog('pack'));
  el('launcherChangelogBtn').addEventListener('click', () => openChangelog('launcher'));
  el('changelogCloseIcon').addEventListener('click', () =>
    el('changelogModal').classList.add('hidden')
  );
  el('changelogModal').addEventListener('click', (event) => {
    if (event.target === el('changelogModal')) el('changelogModal').classList.add('hidden');
  });

  el('updateBtn').addEventListener('click', onUpdateClick);
  el('checkUpdateBtn').addEventListener('click', () => checkUpdate(true));
  el('serverStatus').addEventListener('click', () => refreshServerStatus());

  api.onStatus((message) => {
    el('status').textContent = message;
    el('progressWrap').classList.remove('hidden');
    appendLog('launcher', message);
  });

  api.onProgress((progress) => setProgress(progress.percent, progress.label));

  api.onLog(({ stream, text }) => appendLog(stream, text));

  api.onGameExit((event) => {
    state.exitCount += 1;
    state.busy = false;
    state.running = false;
    updateButtons();

    if (event.error) {
      setProgress(0, 'Ошибка');
      showError(event.error);
    } else if (event.code && event.code !== 0) {
      setProgress(0, 'Игра завершилась с ошибкой');
      showError(`Minecraft завершился с кодом ${event.code}. Подробности — в логе и crash-report.`);
    } else {
      setProgress(100, 'Игра закрыта');
    }

    appendLog('launcher', `Minecraft завершён (код ${event.code ?? '—'})`);
    refreshPackStatus().catch(() => {});
  });

  api.onUpdateAvailable(showUpdate);
  api.onUpdateProgress((progress) => setProgress(progress.percent, 'Загрузка обновления'));
  api.onUpdateStatus((message) => {
    appendLog('launcher', message);
    setProgress(null, message);
  });
}

async function init() {
  bindEvents();

  state.config = await api.getConfig();
  el('nickname').value = state.config.nickname || '';
  el('memory').value = state.config.maxMemoryMb || '';
  el('javaPath').value = state.config.javaPath || '';
  el('appVersion').textContent = `v${state.config.appVersion || '1.0.0'}`;

  // Обновление в прошлый раз скачалось, но не заменило app.asar.
  if (state.config.lastUpdateError) {
    state.updateFailed = true;
    showError(
      `Не удалось применить обновление ${state.config.lastUpdateError.version}: ` +
        `${state.config.lastUpdateError.message}.`
    );
    appendLog(
      'launcher',
      'Обновление не применилось. Журнал: %APPDATA%\\simple-mc-launcher\\update.log'
    );
    // Кнопка обновления могла появиться до чтения конфига.
    if (state.update) {
      el('updateLabel').textContent = `Скачать ${state.update.version} вручную`;
    }
  }

  await loadPacks();
  await checkUpdate(false);

  refreshServerStatus();
  setInterval(refreshServerStatus, 30000);
}

init().catch((error) => {
  showError(errorMessage(error));
  appendLog('launcher', `Критическая ошибка: ${errorMessage(error)}`);
});
