'use strict';

/**
 * Зеркала Maven для загрузчиков.
 *
 * Зачем: @xmcl/installer качает NeoForge/Forge-библиотеки с maven.neoforged.net
 * (а сам установщик NeoForge вообще ищет в Maven Central, где его нет).
 * У части провайдеров maven.neoforged.net недоступен — соединение через
 * CDN зависает, и установка падает с DownloadAggregateError.
 *
 * Поэтому сначала пробуем официальный хост, а затем рабочие зеркала.
 * Порядок важен: официальный источник в приоритете.
 */

// Официальные и зеркальные репозитории Maven.
const OFFICIAL_MAVEN = 'https://maven.neoforged.net/releases/';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/';

const MIRROR_MAVENS = [
  'https://maven.creeperhost.net/',
  'https://repo.papermc.io/repository/maven-public/',
];

const MAVEN_HOSTS = [OFFICIAL_MAVEN, ...MIRROR_MAVENS, FORGE_MAVEN];

// Сколько ждём ответа от Maven, прежде чем переключиться на зеркало.
const MAVEN_PROBE_TIMEOUT_MS = 5000;

/**
 * Проверяет, отвечает ли хост по этому пути.
 * Медленный или недоступный хост отбрасывается до начала больших загрузок.
 */
async function isMavenHostReachable(host, relativePath, timeoutMs = MAVEN_PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${host}${relativePath}`, {
      method: 'HEAD',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Возвращает доступные хосты Maven в порядке приоритета.
 * Официальный хост остаётся первым, если он отвечает в пределах таймаута.
 */
async function resolveMavenHosts(relativePath, hostList = MAVEN_HOSTS) {
  const checks = await Promise.all(
    hostList.map(async (host) => ({
      host,
      ok: await isMavenHostReachable(host, relativePath),
    }))
  );

  const reachable = checks.filter((item) => item.ok).map((item) => item.host);
  if (reachable.length > 0) return reachable;

  // Никто не ответил на проверку — пробуем все хосты при загрузке.
  return hostList;
}

// Путь установщика NeoForge внутри Maven.
function neoforgeInstallerPath(project, version) {
  return `net/neoforged/${project}/${version}/${project}-${version}-installer.jar`;
}

/**
 * Собирает список URL для конкретной библиотеки загрузчика.
 * @xmcl/installer принимает эту функцию как `libraryHost(lib)`
 * и пробует URL по порядку.
 */
function makeLibraryHost() {
  return (library) => {
    const relative = library && library.download ? library.download.path : '';
    if (!relative) return [];
    return MIRROR_MAVENS.map((host) => `${host}${relative}`);
  };
}

/**
 * Параметры для installNeoForged / installForge.
 * officialHost — основной Maven (подставляется как mavenHost),
 * libraryHost — зеркала, которые пробуются, если основной недоступен.
 */
function loaderInstallOptions(base = {}) {
  return {
    ...base,
    mavenHost: [OFFICIAL_MAVEN],
    libraryHost: makeLibraryHost(),
  };
}

module.exports = {
  OFFICIAL_MAVEN,
  FORGE_MAVEN,
  MIRROR_MAVENS,
  MAVEN_HOSTS,
  MAVEN_PROBE_TIMEOUT_MS,
  isMavenHostReachable,
  resolveMavenHosts,
  neoforgeInstallerPath,
  loaderInstallOptions,
  makeLibraryHost,
};
