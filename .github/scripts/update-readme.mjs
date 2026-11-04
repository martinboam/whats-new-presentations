import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'martinboam/whats-new-presentations';
const START = '<!-- latest-presentations:start -->';
const END = '<!-- latest-presentations:end -->';
const PRODUCTS = { copilot: 'Microsoft 365 Copilot', teams: 'Microsoft Teams', agent365: 'Agent 365' };

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

export async function buildLatestSection(github) {
  const candidates = [];
  for (let page = 1; ; page++) {
    const releases = await github(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid GitHub releases response.');
    candidates.push(...releases.map(edition).filter(Boolean));
    if (releases.length < 100) break;
  }
  candidates.sort((a, b) => b.date - a.date || b.revision - a.revision || b.release.id - a.release.id);
  const latest = new Map();
  for (const candidate of candidates) {
    if (latest.has(candidate.product)) continue;
    let hasPresentation = false;
    for (let page = 1; ; page++) {
      const assets = await github(`releases/${candidate.release.id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(assets)) throw new Error('Invalid GitHub assets response.');
      hasPresentation = assets.some(asset => asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) && asset.size > 0 && /\.(pptx?|pdf)$/i.test(asset.name));
      if (hasPresentation || assets.length < 100) break;
    }
    if (hasPresentation) latest.set(candidate.product, candidate.release);
  }
  const rows = Object.entries(PRODUCTS).map(([product, label]) => {
    const release = latest.get(product);
    const link = release
      ? `[${markdownText(release.name || release.tag_name)}](https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)})`
      : 'Not yet published on GitHub';
    return `| ${label} | ${link} | [Browse editions](https://whatsnewcentral.com/downloads.html?category=${product}) |`;
  });
  return ['| Product | Latest GitHub edition | Full library |', '|---|---|---|', ...rows].join('\n');
}

export function replaceLatestSection(readme, section) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + START.length) >= 0 ||
      readme.indexOf(END, end + END.length) >= 0) {
    throw new Error('README must contain exactly one latest-presentations marker pair.');
  }
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  return `${readme.slice(0, start + START.length)}${newline}${section.replace(/\r?\n/g, newline)}${newline}${readme.slice(end)}`;
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
    if (!response.ok) throw new Error(`GitHub README request failed (${response.status}).`);
    return response.json();
  };
  const file = await github('contents/README.md');
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') {
    throw new Error('Invalid README response.');
  }
  const original = Buffer.from(file.content, 'base64').toString('utf8');
  const updated = replaceLatestSection(original, await buildLatestSection(github));
  if (updated === original) {
    console.log('Latest presentation links are already up to date.');
    return false;
  }
  await github('contents/README.md', {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Update latest presentation links\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
      sha: file.sha,
      content: Buffer.from(updated).toString('base64')
    })
  });
  console.log('Updated latest presentation links.');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  updateReadme({ token: process.env.GH_TOKEN, repository: process.env.GH_REPOSITORY }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
