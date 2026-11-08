'use strict';

const { fetchJson } = require('./http');
const { getLauncherRepo } = require('./config');

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();

async function listReleases(repo, limit = 10) {
  if (!repo) return [];

  const key = `${repo}#${limit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const releases = await fetchJson(
    `https://api.github.com/repos/${repo}/releases?per_page=${limit}`,
    { headers: HEADERS }
  );

  const value = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft && release.tag_name)
    .map((release) => ({
      tag: String(release.tag_name),
      version: String(release.tag_name).replace(/^v/i, ''),
      name: String(release.name || release.tag_name),
      notes: String(release.body || ''),
      url: String(release.html_url || ''),
      publishedAt: String(release.published_at || ''),
    }))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getLauncherChangelog() {
  return listReleases(getLauncherRepo(), 10);
}

/**
 * Репозиторий и тег сборки берём из ссылок на релизные ассеты в pack.json.
 * Отдельного поля в манифесте нет, а так ченджлог работает для любой сборки.
 */
function packReleaseSource(pack) {
  const urls = [pack?.archive?.url, ...(pack?.files || []).map((file) => file.url)];
  for (const url of urls) {
    if (!url) continue;
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//i.exec(
      String(url)
    );
    if (match) {
      return {
        repo: `${match[1]}/${match[2]}`,
        tag: decodeURIComponent(match[3]),
      };
    }
  }
  return null;
}

async function getPackChangelog(pack) {
  const source = packReleaseSource(pack);
  if (!source) return [];

  // Теги одной сборки: atmons-1.3.0, atmons-1.3.0-v2, ...
  const base = source.tag.replace(/-v\d+$/i, '');
  const releases = await listReleases(source.repo, 30);

  return releases.filter(
    (release) => release.tag === source.tag || release.tag === base || release.tag.startsWith(`${base}-`)
  );
}

module.exports = {
  getLauncherChangelog,
  getPackChangelog,
  packReleaseSource,
  listReleases,
};
