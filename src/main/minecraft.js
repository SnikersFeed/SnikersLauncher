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
} = require('@xmcl/installer');

const { minecraftDir, instanceDir, dataRoot } = require('./paths');

let running = null;

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
    execFile(
      executable,
      ['-version'],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          resolve(null);
          return;
        }

        const info = parseJavaVersionText(`${stderr || ''}\n${stdout || ''}`);
        resolve(info ? { path: executable, ...info } : null);
      }
    );
  });
}

async function detectJava(requiredMajor, preferredPath) {
  if (preferredPath) {
    const info = await readJavaInfo(preferredPath);
    if (!info) {
      throw new Error(`Java по пути "${preferredPath}" не найден или не запускается`);
    }
    if (info.majorVersion < requiredMajor) {
      throw new Error(
        `Указан Java ${info.majorVersion}, а для этой сборки нужен Java ${requiredMajor}+`
      );
    }
    return info;
  }

  const candidates = new Set(collectJavaCandidates());

  try {
    for (const location of await getPotentialJavaLocations()) {
      candidates.add(location);
    }
  } catch {
    // where java может быть недоступен — не критично.
  }

  const found = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    try {
      const info = await readJavaInfo(candidate);
      if (info) found.push(info);
    } catch {
      // пропускаем нерабочие пути
    }
  }

  const suitable = found
    .filter((info) => info.majorVersion >= requiredMajor)
    .sort((a, b) => a.majorVersion - b.majorVersion || b.version.localeCompare(a.version));

  if (suitable.length === 0) {
    const available = found.map((info) => `${info.majorVersion} (${info.path})`).join(', ');
    throw new Error(
      `Не найден Java ${requiredMajor}+. Установите JDK/JRE ${requiredMajor} и укажите путь в настройках.` +
        (available ? ` Найдено: ${available}` : '')
    );
  }

  return suitable[0];
}

async function ensureMinecraftInstalled(pack, javaPath, onStatus = () => {}) {
  await fsp.mkdir(minecraftDir, { recursive: true });

  onStatus('Получение списка версий Minecraft…');
  const versionList = await getVersionList();
  const versionMeta = versionList.versions.find((item) => item.id === pack.minecraft);

  if (!versionMeta) {
    throw new Error(`Minecraft ${pack.minecraft} не найден в официальном списке версий`);
  }

  onStatus(`Установка Minecraft ${pack.minecraft}…`);
  await install(versionMeta, minecraftDir, { side: 'client' });

  let versionId = pack.minecraft;
  const loader = pack.loader || { type: 'vanilla' };

  if (loader.type === 'fabric') {
    onStatus(`Установка Fabric ${loader.version}…`);
    const artifact = await getFabricLoaderArtifact(pack.minecraft, loader.version);
    versionId = await installFabric(artifact, minecraftDir, { side: 'client' });
  } else if (loader.type === 'forge') {
    onStatus(`Установка Forge ${loader.version}…`);
    versionId = await installForge(
      { mcversion: pack.minecraft, version: loader.version },
      minecraftDir,
      { side: 'client', java: javaPath }
    );
  } else if (loader.type === 'neoforge') {
    onStatus(`Установка NeoForge ${loader.version}…`);
    const project = loader.project || (pack.minecraft === '1.20.1' ? 'forge' : 'neoforge');
    versionId = await installNeoForged(project, loader.version, minecraftDir, {
      side: 'client',
      java: javaPath,
    });
  } else if (loader.type !== 'vanilla') {
    throw new Error(`Неподдерживаемый загрузчик: ${loader.type}`);
  }

  onStatus('Проверка библиотек и ресурсов…');
  const resolved = await Version.parse(minecraftDir, versionId);
  await installDependencies(resolved, { side: 'client' });

  return { versionId, resolved };
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
  const java = await detectJava(requiredJava, preferredJava);

  const { versionId } = await ensureMinecraftInstalled(pack, java.path, onStatus);

  const gameDirectory = instanceDir(pack.id);
  await fsp.mkdir(gameDirectory, { recursive: true });

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
  requiredJavaMajor,
  offlineUuid,
  parseJavaVersionText,
  readJavaInfo,
};
