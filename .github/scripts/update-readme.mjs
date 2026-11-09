import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'martinboam/whats-new-presentations';
const START = '<!-- latest-presentations:start -->';
const END = '<!-- latest-presentations:end -->';
const PRODUCTS = { copilot: 'Microsoft Copilot', teams: 'Microsoft Teams', agent365: 'Agent 365' };

function edition(release) {
  if (release.draft !== false || release.prerelease !== false || !release.published_at) return null;
  const match = /^(copilot|teams|agent365)-(\d{4})-(0[1-9]|1[0-2])(?:-r([2-9]|[1-9]\d+))?$/i.exec(release.tag_name);
  if (!match) return null;
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('Invalid release ID.');
  return { release, product: match[1].toLowerCase(), date: Number(`${match[2]}${match[3]}`),
    revision: Number(match[4] || 1) };
}

function markdownText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
}

function releaseLink(release) {
  return `[${markdownText(release.name || release.tag_name)}](https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)})`;
}

function downloadLinks(candidate) {
  return candidate.assets.map(asset => {
    const format = /\.pdf$/i.test(asset.name) ? 'PDF' : 'PowerPoint';
    const name = encodeURIComponent(asset.name).replace(/[()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    const url = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(candidate.release.tag_name)}/${name}`;
    return `[${format}](${url})`;
  }).join(' / ');
}

export async function buildPresentationIndex(github) {
  const candidates = [];
  for (let page = 1; ; page++) {
    const releases = await github(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid GitHub releases response.');
    candidates.push(...releases.map(edition).filter(Boolean));
    if (releases.length < 100) break;
  }
  candidates.sort((a, b) => b.date - a.date || a.product.localeCompare(b.product) ||
    b.revision - a.revision || b.release.id - a.release.id);
  const editions = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.product}:${candidate.date}`;
    if (editions.has(key)) continue;
    const presentations = [];
    for (let page = 1; ; page++) {
      const assets = await github(`releases/${candidate.release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(assets)) throw new Error('Invalid GitHub assets response.');
      presentations.push(...assets.filter(asset => asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) && asset.size > 0 && /\.(pptx?|pdf)$/i.test(asset.name)));
      if (assets.length < 100) break;
    }
    if (presentations.length) editions.set(key, { ...candidate, assets: presentations });
  }
  const entries = [...editions.values()];
  const latest = new Map();
  for (const candidate of entries) {
    if (!latest.has(candidate.product)) latest.set(candidate.product, candidate);
  }
  const rows = Object.entries(PRODUCTS).map(([product, label]) => {
    const candidate = latest.get(product);
    return `| ${label} | ${candidate ? releaseLink(candidate.release) : 'Not yet published on GitHub'} | ${candidate ? downloadLinks(candidate) : '-'} | [Browse editions](https://whatsnewcentral.com/downloads.html?category=${product}) |`;
  });
  const archiveRows = entries.map(candidate => {
    const date = String(candidate.date);
    return `| ${date.slice(0, 4)}-${date.slice(4)} | ${PRODUCTS[candidate.product]} | ${releaseLink(candidate.release)} | ${downloadLinks(candidate)} |`;
  });
  return {
    editions: entries,
    latestSection: ['| Product | Latest GitHub edition | Download | Full library |', '|---|---|---|---|', ...rows].join('\n'),
    archiveSection: entries.length
      ? ['| Edition | Product | Release details | Download |', '|---|---|---|---|', ...archiveRows].join('\n')
      : 'No presentation editions have been published on GitHub yet. [Browse the full library](https://whatsnewcentral.com/downloads.html).'
  };
}

export async function buildLatestSection(github) {
  return (await buildPresentationIndex(github)).latestSection;
}

function replaceSection(readme, section, startMarker, endMarker) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start < 0 || end < start || readme.indexOf(startMarker, start + startMarker.length) >= 0 ||
      readme.indexOf(endMarker, end + endMarker.length) >= 0) {
    throw new Error(`README must contain exactly one ${startMarker} marker pair.`);
  }
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  return `${readme.slice(0, start + startMarker.length)}${newline}${section.replace(/\r?\n/g, newline)}${newline}${readme.slice(end)}`;
}

export function replaceLatestSection(readme, section) {
  return replaceSection(readme, section, START, END);
}

export function replaceArchiveSection(readme, section) {
  return replaceSection(readme, section, '<!-- presentation-archive:start -->', '<!-- presentation-archive:end -->');
}

export async function updateLatestRelease(github, editions) {
  if (!editions.length) return false;
  const current = await github('releases/latest');
  if (current) {
    if (!Number.isSafeInteger(current.id) || current.id <= 0) throw new Error('Invalid latest release response.');
    const currentEdition = edition(current);
    if (currentEdition?.date > editions[0].date ||
        editions.some(candidate => candidate.date === editions[0].date && candidate.release.id === current.id)) {
      return false;
    }
    const sameProduct = editions.find(candidate => candidate.product === currentEdition?.product &&
      candidate.date === currentEdition?.date);
    if (currentEdition?.date === editions[0].date && sameProduct &&
        currentEdition.revision > sameProduct.revision) return false;
  }
  await github(`releases/${editions[0].release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ make_latest: 'true' })
  });
  console.log(`Set GitHub Latest to ${editions[0].release.tag_name}.`);
  return true;
}

export async function updateReadme({ token, repository, request = fetch }) {
  if (repository !== REPOSITORY) throw new Error('Unexpected publishing repository.');
  if (!token) throw new Error('GitHub token is required.');
  const github = async (path, options = {}) => {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(30000)
    });
    if (response.status === 404 && path === 'releases/latest') return null;
    if (!response.ok) throw new Error(`GitHub README request failed (${response.status}).`);
    return response.json();
  };
  const file = await github('contents/README.md');
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') {
    throw new Error('Invalid README response.');
  }
  const original = Buffer.from(file.content, 'base64').toString('utf8');
  const index = await buildPresentationIndex(github);
  const updated = replaceArchiveSection(replaceLatestSection(original, index.latestSection), index.archiveSection);
  let changed = false;
  if (updated !== original) {
    await github('contents/README.md', {
      method: 'PUT',
      body: JSON.stringify({
        message: 'Update presentation edition index\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
        sha: file.sha,
        content: Buffer.from(updated).toString('base64')
      })
    });
    console.log('Updated latest links and newest-first presentation archive.');
    changed = true;
  }
  const latestChanged = await updateLatestRelease(github, index.editions);
  if (!changed && !latestChanged) console.log('Presentation index and Latest badge are already up to date.');
  return changed || latestChanged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  updateReadme({ token: process.env.GH_TOKEN, repository: process.env.GH_REPOSITORY }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
