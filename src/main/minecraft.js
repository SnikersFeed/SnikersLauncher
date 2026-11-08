'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { app } = require('electron');

const {
  Version,
  launch,
  createMinecraftProcessWatcher,
} = require('@xmcl/core');

const {
  getVersionList,
  install,
  installDependencies,
  installForge,
  installNeoForged,
  getFabricLoaderArtifact,
  installFabric,
  getPotentialJavaLocations,
  fetchJavaRuntimeManifest,
  installJavaRuntimeTask,
} = require('@xmcl/installer');

const { minecraftDir, instanceDir, dataRoot } = require('./paths');
const { downloadToFile } = require('./http');
const {
  OFFICIAL_MAVEN,
  neoforgeInstallerPath,
  makeLibraryHost,
  resolveMavenHosts,
} = require('./maven');

let running = null;

/**
 * Скачивает установщик NeoForge с первого доступного зеркала.
 *
 * @xmcl/installer ищет установщик только в Maven Central (там его нет) и на
 * maven.neoforged.net, который у части провайдеров зависает. Поэтому файл
 * скачиваем сами, а installNeoForged получает уже готовый jar через libraryHost.
 *
 * Возвращает { jarPath, versionId } — путь к jar и имя версии из installer.
 */
/**
 * Ошибки вроде EPERM/EBUSY при переименовании лечатся повтором:
 * антивирус или завершающийся процесс игры могут ещё держать файл.
 */
async function downloadWithRetries(url, destination, tries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await downloadToFile(url, destination);
    } catch (error) {
      lastError = error;
      if (!/EPERM|EBUSY|EACCES|UNKNOWN/i.test(String(error.code || error.message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
  }

  throw lastError;
}

async function fetchNeoForgeInstaller(project, version, { onStatus = () => {} } = {}) {
  const relative = neoforgeInstallerPath(project, version);
  const jarPath = path.join(minecraftDir, 'libraries', ...relative.split('/'));

  await fsp.mkdir(path.dirname(jarPath), { recursive: true });
  onStatus(`Скачивание установщика NeoForge ${version}…`);

  const hosts = await resolveMavenHosts(relative);
  const errors = [];

  for (const host of hosts) {
    const url = `${host}${relative}`;
    try {
      await downloadWithRetries(url, jarPath);
      return { jarPath, versionId: `${project}-${version}` };
    } catch (error) {
      errors.push(`${host} — ${String(error.message).split('\n')[0]}`);
    }
  }

  throw new Error(
    'Не удалось скачать установщик NeoForge ни с одного зеркала:\n' +
      errors.map((line) => `  • ${line}`).join('\n')
  );
}

/**
 * Ставит загрузчик и возвращает id установленной версии.
 * Ставит и сам загрузчик, и его библиотеки, поэтому installDependencies
 * после этого вызывать не нужно.
 */
async function installLoader(pack, javaPath, onStatus = () => {}) {
  const loader = pack.loader || { type: 'vanilla' };

  if (loader.type === 'fabric') {
    onStatus(`Установка Fabric ${loader.version}…`);
    const artifact = await getFabricLoaderArtifact(pack.minecraft, loader.version);
    return installFabric(artifact, minecraftDir, { side: 'client' });
  }

  if (loader.type === 'forge') {
    onStatus(`Установка Forge ${loader.version}…`);
    return installForge({ mcversion: pack.minecraft, version: loader.version }, minecraftDir, {
      side: 'client',
      java: javaPath,
      mavenHost: [OFFICIAL_MAVEN],
      libraryHost: makeLibraryHost(),
    });
  }

  if (loader.type === 'neoforge') {
    const project = loader.project || (pack.minecraft === '1.20.1' ? 'forge' : 'neoforge');

    const { versionId } = await fetchNeoForgeInstaller(project, loader.version, { onStatus });

    onStatus(`Установка NeoForge ${loader.version}…`);
    return installNeoForged(project, loader.version, minecraftDir, {
      side: 'client',
      java: javaPath,
      versionId,
      mavenHost: [OFFICIAL_MAVEN],
      libraryHost: makeLibraryHost(),
    });
  }

  if (loader.type !== 'vanilla') {
    throw new Error(`Неподдерживаемый загрузчик: ${loader.type}`);
  }

  return pack.minecraft;
}

function requiredJavaMajor(minecraftVersion) {
  const parts = String(minecraftVersion).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const major = parts[0] || 1;
  const minor = parts[1] || 0;
  const patch = parts[2] || 0;

  if (major > 1) return 21;
  if (minor >= 21) return 21;
  if (minor === 20 && patch >= 5) return 21;
  if (minor >= 17) return 17;
  return 8;
}

function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();

  // UUID v3
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function listSubdirectories(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function javaExecutable(root) {
  return path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function collectJavaCandidates() {
  const candidates = new Set();
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) candidates.add(javaExecutable(javaHome));

  const programFiles = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
  ].filter(Boolean);

  const vendors = [
    'Java',
    'Eclipse Adoptium',
    'Eclipse Foundation',
    'Microsoft',
    'Zulu',
    'BellSoft',
    'Amazon Corretto',
    'Semeru',
  ];

  for (const base of programFiles) {
    for (const vendor of vendors) {
      const vendorDir = path.join(base, vendor);
      for (const versionDir of listSubdirectories(vendorDir)) {
        candidates.add(javaExecutable(versionDir));
        candidates.add(javaExecutable(path.join(versionDir, 'jre')));
      }
    }
  }

  // Рантаймы, которые скачал официальный лаунчер Minecraft.
  for (const appData of [process.env.APPDATA, path.join(dataRoot, 'runtime')].filter(Boolean)) {
    const runtimeRoot = appData.endsWith('runtime') ? appData : path.join(appData, '.minecraft', 'runtime');
    for (const runtime of listSubdirectories(runtimeRoot)) {
      for (const platformDir of listSubdirectories(runtime)) {
        candidates.add(javaExecutable(platformDir));
      }
      candidates.add(javaExecutable(runtime));
    }
  }

  for (const jdk of listSubdirectories(path.join(process.env.USERPROFILE || '', '.jdks'))) {
    candidates.add(javaExecutable(jdk));
  }

  candidates.add(process.platform === 'win32' ? 'java.exe' : 'java');
  return [...candidates];
}

/**
 * Разбирает вывод `java -version`.
 * Поддерживает и Java 8 (`1.8.0_402`), и современные (`17.0.5`, `21`).
 * Своя реализация нужна, потому что resolveJava из @xmcl/installer падает
 * на версиях вида `1.8.0-262` необработанным исключением.
 */
function parseJavaVersionText(text) {
  const match = /version "([^"]+)"/i.exec(String(text || ''));
  if (!match) return null;

  const raw = match[1].trim();
  const parts = raw.split(/[._+-]/).map((part) => Number.parseInt(part, 10));

  let majorVersion;
  let patch = -1;

  if (parts[0] === 1 && Number.isFinite(parts[1])) {
    majorVersion = parts[1];
    patch = Number.isFinite(parts[3]) ? parts[3] : Number.isFinite(parts[2]) ? parts[2] : -1;
  } else {
    majorVersion = parts[0];
    patch = Number.isFinite(parts[2]) ? parts[2] : -1;
  }

  if (!Number.isFinite(majorVersion)) return null;
  return { version: raw, majorVersion, patch };
}

function readJavaInfo(executable) {
  return new Promise((resolve) => {
    try {
      execFile(
        executable,
        ['-version'],
        { windowsHide: true, timeout: 20000 },
        (error, stdout, stderr) => {
          // Не запускается вообще (нет файла, битый рантайм) — просто «Java нет».
          if (error && !stdout && !stderr) {
            resolve(null);
            return;
          }

          const info = parseJavaVersionText(`${stderr || ''}\n${stdout || ''}`);
          resolve(info ? { path: executable, ...info } : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Выбирает Java строго нужной мажорной версии.
 * Java 22 не заменяет 21: Cobblemon (и NeoForge 1.21.1) объявляют bound [21, 22)
 * и ломаются на 22 с «Registry is already frozen».
 */
function pickJava(installs, requiredMajor) {
  return (
    installs
      .filter((info) => info.majorVersion === requiredMajor)
      .sort((a, b) => b.version.localeCompare(a.version))[0] || null
  );
}

async function detectJava(requiredMajor, preferredPath) {
  if (preferredPath) {
    const info = await readJavaInfo(preferredPath);
    if (!info) {
      throw new Error(`Java по пути "${preferredPath}" не найден или не запускается`);
    }
    if (info.majorVersion !== requiredMajor) {
      throw new Error(
        `Указан Java ${info.majorVersion}, а для этой сборки нужен Java ${requiredMajor}`
      );
    }
    return info;
  }

  const found = await findJavaInstalls();
  const suitable = pickJava(found, requiredMajor);

  if (!suitable) {
    const available = found.map((info) => `${info.majorVersion} (${info.path})`).join(', ');
    throw new Error(
      `Не найден Java ${requiredMajor}. Установите JDK/JRE ${requiredMajor} и укажите путь в настройках.` +
        (available ? ` Найдено: ${available}` : '')
    );
  }

  return suitable;
}

// Рантаймы, которые раздаёт Mojang (launchermeta). Других мажорных версий там нет.
const RUNTIME_DIR = path.join(dataRoot, 'runtimes');

const MOJANG_RUNTIMES = {
  8: ['jre-legacy', 'java-runtime-alpha'],
  16: ['java-runtime-alpha', 'java-runtime-beta'],
  17: ['java-runtime-beta', 'java-runtime-gamma'],
  21: ['java-runtime-delta', 'java-runtime-epsilon'],
};

/** Все найденные на компьютере Java с версиями. */
async function findJavaInstalls() {
  const candidates = new Set(collectJavaCandidates());

  try {
    for (const location of await getPotentialJavaLocations()) {
      candidates.add(location);
    }
  } catch {
    // where java может быть недоступен — не критично.
  }

  // Ранее установленные лаунчером рантаймы ищем первыми.
  for (const runtime of listSubdirectories(RUNTIME_DIR)) {
    candidates.add(javaExecutable(runtime));
    for (const nested of listSubdirectories(runtime)) candidates.add(javaExecutable(nested));
  }

  const found = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      const info = await readJavaInfo(candidate);
      if (info) found.push(info);
    } catch {
      // пропускаем нерабочие пути
    }
  }

  return found;
}

/**
 * Скачивает и распаковывает JRE нужной версии от Mojang в папку данных лаунчера.
 * Возвращает путь к java.exe; при недоступности источника — null.
 */
async function installMojangRuntime(major, onStatus = () => {}) {
  const targets = MOJANG_RUNTIMES[major];
  if (!targets) return null;

  for (const target of targets) {
    const destination = path.join(RUNTIME_DIR, target);
    const existing = await readJavaInfo(javaExecutable(destination));
    if (existing && existing.majorVersion >= major) return existing.path;

    // Прошлая попытка могла оставить недокачанные файлы — начинаем заново.
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => {});
    onStatus(`Скачивание Java ${major} (${target})…`);

    try {
      const manifest = await fetchJavaRuntimeManifest({ target });
      await fsp.mkdir(destination, { recursive: true });

      const task = installJavaRuntimeTask({ destination, manifest });

      let lastPercent = -1;
      await new Promise((resolve, reject) => {
        task.start({
          onUpdate: () => {
            // Дерево задач: берём прогресс корня, он уже в процентах.
            const percent =
              typeof task.progress === 'number' && task.total > 0
                ? Math.round((task.progress / task.total) * 100)
                : null;

            if (percent !== lastPercent) {
              lastPercent = percent;
              onStatus(`Установка Java ${major}${percent === null ? '…' : `: ${percent}%`}`);
            }
          },
          onFailed: (_task, error) => reject(error),
        });

        task.wait().then(resolve, reject);
      });
    } catch (error) {
      onStatus(`Не удалось скачать Java ${major}: ${error.message}`);
      console.warn(`[java] ${target}:`, error);
      continue;
    }

    const info = await readJavaInfo(javaExecutable(destination));
    if (info) return info.path;
  }

  return null;
}

/**
 * Находит подходящую Java или сама ставит её, если на компьютере нужной нет.
 * onStatus сообщает о шагах, onInstallAttempt(false) — если автоустановка невозможна.
 */
async function ensureJava(requiredMajor, preferredPath, options = {}) {
  const { onStatus = () => {}, allowDownload = true } = options;

  if (preferredPath) {
    const info = await readJavaInfo(preferredPath);
    if (info && info.majorVersion === requiredMajor) return info;

    // Пользователь указал другую Java — подбираем/ставим нужную сами.
    if (info) {
      onStatus(`Java ${info.majorVersion} не подходит, нужен Java ${requiredMajor}`);
    }
  }

  const found = await findJavaInstalls();
  const suitable = pickJava(found, requiredMajor);

  if (suitable) return suitable;

  if (!allowDownload) throw new Error(`Не найден Java ${requiredMajor}`);

  onStatus(`Java ${requiredMajor} не найдена на компьютере — устанавливаю автоматически…`);
  const installedPath = await installMojangRuntime(requiredMajor, onStatus);

  if (installedPath) {
    const info = await readJavaInfo(installedPath);
    if (info) {
      onStatus(`Java ${info.majorVersion} установлена`);
      return info;
    }
  }

  const available = found.map((info) => `${info.majorVersion} (${info.path})`).join(', ');
  throw new Error(
    `Не найден и не удалось установить Java ${requiredMajor}. ` +
      'Установите JDK/JRE вручную и укажите путь в настройках.' +
      (available ? ` Найдено: ${available}` : '')
  );
}

async function ensureMinecraftInstalled(pack, javaPath, onStatus = () => {}) {
  await fsp.mkdir(minecraftDir, { recursive: true });

  const loader = pack.loader || { type: 'vanilla' };

  onStatus('Получение списка версий Minecraft…');
  const versionList = await getVersionList();
  const versionMeta = versionList.versions.find((item) => item.id === pack.minecraft);

  if (!versionMeta) {
    throw new Error(`Minecraft ${pack.minecraft} не найден в официальном списке версий`);
  }

  onStatus(`Установка Minecraft ${pack.minecraft}…`);
  await install(versionMeta, minecraftDir, { side: 'client' });

  const versionId = await installLoader(pack, javaPath, onStatus);

  onStatus('Проверка библиотек и ресурсов…');
  const resolved = await Version.parse(minecraftDir, versionId);

  // Для загрузчиков библиотеки уже скачаны installLoader —
  // installDependencies докачает только недостающее (например, assets).
  await installDependencies(resolved, { side: 'client' });

  return { versionId, resolved };
}

/**
 * Ключ установки: меняется только при смене Minecraft или загрузчика.
 * Файлы сборки (моды, конфиги) на него не влияют — их обновляет syncInstance.
 */
function loaderInstallKey(pack) {
  const loader = pack.loader || { type: 'vanilla' };
  const project =
    loader.type === 'neoforge'
      ? loader.project || (pack.minecraft === '1.20.1' ? 'forge' : 'neoforge')
      : '';
  return [pack.minecraft, loader.type, project, loader.version || ''].join('|');
}

function installMarkerPath(dir) {
  return path.join(dir, '.launcher', 'minecraft.json');
}

async function readInstallMarker(dir) {
  try {
    return JSON.parse(await fsp.readFile(installMarkerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

async function writeInstallMarker(dir, marker) {
  const file = installMarkerPath(dir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(marker, null, 2), 'utf8');
}

function versionInstalled(versionId) {
  return fs.existsSync(path.join(minecraftDir, 'versions', versionId, `${versionId}.json`));
}

/**
 * Ставить загрузчик заново нужно только если ключ изменился или файлы версии
 * пропали. Проверяем только version json: библиотеки и assets качаются один раз
 * при установке.
 */
function canReuseInstall(marker, key) {
  return Boolean(marker && marker.key === key && marker.versionId && versionInstalled(marker.versionId));
}

function normalizeServer(server) {
  if (!server) return undefined;

  if (typeof server === 'string') {
    const [ip, port] = server.split(':');
    if (!ip) return undefined;
    return { ip, port: Number(port) || 25565 };
  }

  if (server.ip) {
    return { ip: String(server.ip), port: Number(server.port) || 25565 };
  }

  return undefined;
}

async function play(options) {
  const {
    pack,
    nickname,
    javaPath: preferredJava,
    memory,
    onStatus = () => {},
    onLog = () => {},
    onExit = () => {},
  } = options;

  if (running) {
    throw new Error('Игра уже запущена');
  }

  const requiredJava = pack.java || requiredJavaMajor(pack.minecraft);
  onStatus(`Поиск Java ${requiredJava}+…`);
  const java = await ensureJava(requiredJava, preferredJava, { onStatus });

  const gameDirectory = instanceDir(pack.id);
  await fsp.mkdir(gameDirectory, { recursive: true });

  // NeoForge/Forge ставим только при первой установке или смене версии
  // Minecraft/загрузчика — повторная установка на каждом запуске не нужна.
  const installKey = loaderInstallKey(pack);
  const marker = await readInstallMarker(gameDirectory);

  let versionId;
  if (canReuseInstall(marker, installKey)) {
    versionId = marker.versionId;
  } else {
    ({ versionId } = await ensureMinecraftInstalled(pack, java.path, onStatus));
    await writeInstallMarker(gameDirectory, { key: installKey, versionId });
  }

  onStatus('Запуск Minecraft…');

  const memoryConfig = {
    minMb: Math.min(memory?.minMb || pack.memory.minMb, memory?.maxMb || pack.memory.maxMb),
    maxMb: memory?.maxMb || pack.memory.maxMb,
  };

  const process = await launch({
    gamePath: gameDirectory,
    resourcePath: minecraftDir,
    javaPath: java.path,
    version: versionId,
    gameProfile: { name: nickname, id: offlineUuid(nickname) },
    accessToken: '0'.repeat(32),
    userType: 'legacy',
    minMemory: memoryConfig.minMb,
    maxMemory: memoryConfig.maxMb,
    extraJVMArgs: pack.jvmArgs,
    extraMCArgs: pack.gameArgs,
    resolution: pack.resolution
      ? {
          width: Number(pack.resolution.width) || undefined,
          height: Number(pack.resolution.height) || undefined,
          fullscreen: Boolean(pack.resolution.fullscreen),
        }
      : undefined,
    server: normalizeServer(pack.server),
    launcherName: 'SimpleMCLauncher',
    launcherBrand: app.getVersion(),
    extraExecOption: { windowsHide: false },
  });

  const watcher = createMinecraftProcessWatcher(process);

  running = {
    process,
    watcher,
    packId: pack.id,
    startedAt: Date.now(),
  };

  process.stdout?.on('data', (chunk) => onLog('stdout', chunk.toString()));
  process.stderr?.on('data', (chunk) => onLog('stderr', chunk.toString()));

  watcher.on('minecraft-window-ready', () => onStatus('Игра запущена'));
  watcher.on('minecraft-exit', (event) => {
    running = null;
    onExit(event);
  });
  process.on('error', (error) => {
    running = null;
    onExit({ code: -1, error: error.message });
  });

  onStatus('Игра запущена');
  return { pid: process.pid, versionId, java: java.path };
}

function stop() {
  if (!running) return false;
  running.process.kill();
  return true;
}

function isRunning() {
  return Boolean(running);
}

module.exports = {
  play,
  stop,
  isRunning,
  detectJava,
  ensureJava,
  pickJava,
  findJavaInstalls,
  installMojangRuntime,
  requiredJavaMajor,
  offlineUuid,
  parseJavaVersionText,
  readJavaInfo,
  ensureMinecraftInstalled,
  installLoader,
  fetchNeoForgeInstaller,
  loaderInstallKey,
  readInstallMarker,
  writeInstallMarker,
  versionInstalled,
  canReuseInstall,
};
