import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPresentationIndex, replaceLatestSection, replaceArchiveSection,
  updateLatestRelease, updateReadme
} from './update-readme.mjs';

const repository = 'martinboam/whats-new-presentations';
const asset = { name: 'October deck.pptx', size: 12, state: 'uploaded' };
const release = (id, tag, overrides = {}) => ({
  id, tag_name: tag, name: tag, draft: false, prerelease: false,
  published_at: '2026-11-04T09:50:11Z', ...overrides
});
const readme = [
  'Manual introduction',
  '<!-- latest-presentations:start -->', 'old', '<!-- latest-presentations:end -->',
  '## Presentation archive',
  '<!-- presentation-archive:start -->', 'old', '<!-- presentation-archive:end -->',
  'Manual licensing and attribution'
].join('\n');

function catalogue(releases, assets = {}) {
  const calls = [];
  return {
    calls,
    github: async path => {
      calls.push(path);
      if (path.startsWith('releases?')) return releases;
      const id = Number(path.split('/')[1]);
      return assets[id] || [asset];
    }
  };
}

test('archive sorts edition year/month, not upload date, release ID or product-wide revisions', async () => {
  const { github } = catalogue([
    release(90, 'copilot-2026-08', { published_at: '2027-01-01T00:00:00Z' }),
    release(1, 'Copilot-2026-10'),
    release(80, 'teams-2026-09-r10'),
    release(2, 'teams-2026-10'),
    release(3, 'agent365-2027-01')
  ]);
  const index = await buildPresentationIndex(github);
  assert.deepEqual(index.editions.map(entry => entry.date), [202701, 202610, 202610, 202609, 202608]);
  assert.match(index.latestSection, /Microsoft Copilot \| \[Copilot-2026-10\]/);
  assert.ok(index.archiveSection.indexOf('Copilot-2026-10') < index.archiveSection.indexOf('copilot-2026-08'));
  assert.match(index.archiveSection, /\| 2027-01 \| Agent 365/);
});

test('each product/month shows only its highest uploaded numeric revision, with fallback for unfinished corrections', async () => {
  const { github, calls } = catalogue([
    release(1, 'copilot-2026-09'),
    release(2, 'copilot-2026-09-r2'),
    release(3, 'copilot-2026-09-r10'),
    release(4, 'copilot-2026-10-r2'),
    release(5, 'copilot-2026-10')
  ], { 4: [] });
  const index = await buildPresentationIndex(github);
  assert.deepEqual(index.editions.map(entry => entry.release.id), [5, 3]);
  assert.doesNotMatch(index.archiveSection, /tag\/copilot-2026-09-r2\)/);
  assert.ok(!calls.some(path => path.startsWith('releases/1/')));
});

test('special editions remain separate from monthly releases and their own numeric corrections', async () => {
  const { github } = catalogue([
    release(1, 'copilot-2026-03'),
    release(2, 'copilot-2026-03-special-frontier'),
    release(3, 'copilot-2026-03-special-frontier-r10'),
    release(4, 'copilot-2026-03-special-frontier-r2'),
    release(5, 'copilot-2026-11-special-ignite')
  ]);
  const index = await buildPresentationIndex(github);
  assert.equal(index.editions.length, 3);
  assert.match(index.latestSection, /tag\/copilot-2026-03\)/);
  assert.doesNotMatch(index.latestSection, /special-/);
  assert.match(index.archiveSection, /Microsoft Copilot \(special edition\)/);
  assert.match(index.archiveSection, /tag\/copilot-2026-03-special-frontier-r10\)/);
  assert.doesNotMatch(index.archiveSection, /tag\/copilot-2026-03-special-frontier-r2\)/);
  assert.ok(index.archiveSection.indexOf('copilot-2026-03)') < index.archiveSection.indexOf('copilot-2026-03-special-frontier-r10)'));
});

test('drafts, prereleases, unrelated tags and non-presentation or unfinished assets cannot enter either table', async () => {
  const { github } = catalogue([
    release(1, 'copilot-2026-11', { draft: true }),
    release(2, 'copilot-2026-11-r2', { prerelease: true }),
    release(3, 'copilot-2026-13'), release(4, 'other-2026-11'),
    release(5, 'teams-2026-09', { name: 'Teams - August and September 2026' }),
    release(6, 'copilot-2026-10')
  ], { 6: [
    { ...asset, name: 'cover.png' }, { ...asset, name: 'deck.pptx.upload-temp' },
    { ...asset, size: 0 }, { ...asset, state: 'starter' }
  ] });
  const index = await buildPresentationIndex(github);
  assert.equal(index.editions.length, 1);
  assert.match(index.archiveSection, /\| 2026-09 \| Microsoft Teams \| \[Teams - August and September 2026\]/);
  assert.match(index.latestSection, /Microsoft Copilot \| Not yet published/);
});

test('direct links preserve tag and filename case, encode names and use only the fixed GitHub repository', async () => {
  const { github } = catalogue([release(1, 'Copilot-2026-10', { name: 'Copilot | [notes]\nOctober' })], {
    1: [asset, { ...asset, name: 'October (PDF).PDF', browser_download_url: 'https://evil.test/file.pdf' }]
  });
  const index = await buildPresentationIndex(github);
  for (const section of [index.latestSection, index.archiveSection]) {
    assert.ok(section.includes('releases/download/Copilot-2026-10/October%20deck.pptx'));
    assert.ok(section.includes('releases/download/Copilot-2026-10/October%20%28PDF%29.PDF'));
    assert.ok(section.includes('Copilot \\| \\[notes\\] October'));
    assert.match(section, /\[PDF\]/);
    assert.doesNotMatch(section, /evil\.test/);
  }
});

test('all release and asset pages are read, including additional PDFs after an existing presentation', async () => {
  const calls = [];
  const index = await buildPresentationIndex(async path => {
    calls.push(path);
    if (path === 'releases?per_page=100&page=1') return Array.from({ length: 100 }, (_, i) =>
      release(i + 1, 'unrelated'));
    if (path.startsWith('releases?')) return [release(200, 'teams-2026-10')];
    if (path.endsWith('page=1')) return [asset, ...Array.from({ length: 99 }, () => ({ ...asset, name: 'cover.png' }))];
    return [{ ...asset, name: 'deck.pdf' }];
  });
  assert.ok(calls.includes('releases?per_page=100&page=2'));
  assert.ok(calls.includes('releases/200/assets?per_page=100&page=2'));
  assert.equal(index.editions[0].assets.length, 2);
  assert.match(index.archiveSection, /\[PowerPoint\].*\[PDF\]/);
});

test('empty catalogues are explicit and malformed API data fails rather than producing an empty success', async () => {
  const index = await buildPresentationIndex(async () => []);
  assert.equal(index.editions.length, 0);
  assert.match(index.archiveSection, /No presentation editions/);
  await assert.rejects(buildPresentationIndex(async () => ({})), /Invalid GitHub releases/);
  await assert.rejects(buildPresentationIndex(async path =>
    path.startsWith('releases?') ? [release(1, 'teams-2026-10')] : {}), /Invalid GitHub assets/);
  await assert.rejects(buildPresentationIndex(async () => [release(0, 'teams-2026-10')]), /Invalid release ID/);
});

test('both generated blocks preserve manual content and CRLF, and missing or duplicate markers fail explicitly', () => {
  const original = readme.replace(/\n/g, '\r\n');
  const result = replaceArchiveSection(replaceLatestSection(original, 'new latest'), 'new archive');
  assert.ok(result.startsWith('Manual introduction\r\n'));
  assert.ok(result.endsWith('Manual licensing and attribution'));
  assert.ok(result.includes('\r\nnew archive\r\n'));
  assert.doesNotMatch(result, /(?<!\r)\n/);
  for (const replace of [replaceLatestSection, replaceArchiveSection]) {
    assert.throws(() => replace('', 'new'), /marker pair/);
    assert.throws(() => replace(readme + readme, 'new'), /marker pair/);
  }
});

test('Latest badge advances from an older month using only make_latest, never modifying release files or dates', async () => {
  const { editions } = await buildPresentationIndex(catalogue([release(1, 'Copilot-2026-10')]).github);
  const calls = [];
  assert.equal(await updateLatestRelease(async (path, options) => {
    calls.push([path, options]);
    return release(2, 'teams-2026-09');
  }, editions), true);
  assert.equal(calls[1][0], 'releases/1');
  assert.deepEqual(calls[1][1], { method: 'PATCH', body: JSON.stringify({ make_latest: 'true' }) });
});

test('archive backfills do not displace Latest and a current newest-month product is retained on ties', async () => {
  const { editions } = await buildPresentationIndex(catalogue([
    release(1, 'copilot-2026-10'), release(2, 'teams-2026-10'), release(90, 'copilot-2026-08')
  ]).github);
  const calls = [];
  assert.equal(await updateLatestRelease(async (path, options) => {
    calls.push([path, options]);
    return release(2, 'teams-2026-10');
  }, editions), false);
  assert.equal(calls.length, 1);
});

test('a concurrent newer month or correction is never downgraded by an older index snapshot', async () => {
  const { editions } = await buildPresentationIndex(catalogue([release(1, 'copilot-2026-10-r2')]).github);
  for (const current of [release(2, 'teams-2026-11'), release(3, 'copilot-2026-10-r10')]) {
    let calls = 0;
    assert.equal(await updateLatestRelease(async () => { calls++; return current; }, editions), false);
    assert.equal(calls, 1);
  }
  assert.equal(await updateLatestRelease(async () => assert.fail('No releases means no badge request'), []), false);
});

function apiFixture({ original = readme, current = release(2, 'teams-2026-09'), failure } = {}) {
  let content = original;
  const writes = [];
  const request = async (url, options) => {
    const path = url.split(`/repos/${repository}/`)[1];
    if (options.method) {
      writes.push({ path, ...options });
      if (failure) return new Response(null, { status: failure });
    }
    if (path === 'contents/README.md') {
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        assert.equal(body.sha, 'current-sha');
        assert.match(body.message, /Co-authored-by: Copilot/);
        content = Buffer.from(body.content, 'base64').toString('utf8');
        return Response.json({});
      }
      return Response.json({ content: Buffer.from(content).toString('base64'), encoding: 'base64', sha: 'current-sha' });
    }
    if (path === 'releases/latest') return current ? Response.json(current) : new Response(null, { status: 404 });
    if (path === 'releases/1' && options.method === 'PATCH') {
      current = release(1, 'Copilot-2026-10');
      return Response.json(current);
    }
    if (path.startsWith('releases?')) return Response.json([release(1, 'Copilot-2026-10')]);
    if (path.startsWith('releases/1/assets?')) return Response.json([asset]);
    assert.fail(`Unexpected API request: ${path}`);
  };
  return { request, writes, content: () => content };
}

test('README update is SHA-guarded, preserves manual text, refreshes the badge and makes no redundant writes', async () => {
  const api = apiFixture();
  assert.equal(await updateReadme({ token: 'test-only', repository, request: api.request }), true);
  assert.deepEqual(api.writes.map(write => [write.path, write.method]), [
    ['contents/README.md', 'PUT'], ['releases/1', 'PATCH']
  ]);
  assert.match(api.content(), /^Manual introduction\n/);
  assert.match(api.content(), /Manual licensing and attribution$/);
  assert.equal(await updateReadme({ token: 'test-only', repository, request: api.request }), false);
  assert.equal(api.writes.length, 2);
});

test('an unchanged README does not prevent repairing a stale Latest badge', async () => {
  const index = await buildPresentationIndex(catalogue([release(1, 'Copilot-2026-10')]).github);
  const original = replaceArchiveSection(replaceLatestSection(readme, index.latestSection), index.archiveSection);
  const api = apiFixture({ original });
  assert.equal(await updateReadme({ token: 'test-only', repository, request: api.request }), true);
  assert.deepEqual(api.writes.map(write => write.method), ['PATCH']);
});

test('first eligible release handles the documented missing-Latest 404 without hiding other HTTP failures', async () => {
  const api = apiFixture({ current: null });
  assert.equal(await updateReadme({ token: 'test-only', repository, request: api.request }), true);
  assert.equal(api.writes.at(-1).method, 'PATCH');
  for (const status of [403, 404, 409, 500]) {
    await assert.rejects(updateReadme({
      token: 'test-only', repository, request: async () => new Response(null, { status })
    }), new RegExp(String(status)));
  }
});

test('invalid markers and failed writes stop the workflow explicitly without continuing to badge changes', async () => {
  const missing = apiFixture({ original: 'manual text without generated markers' });
  await assert.rejects(updateReadme({ token: 'test-only', repository, request: missing.request }), /marker pair/);
  assert.equal(missing.writes.length, 0);
  const conflicted = apiFixture({ failure: 409 });
  await assert.rejects(updateReadme({ token: 'test-only', repository, request: conflicted.request }), /409/);
  assert.equal(conflicted.writes.length, 1);
  const denied = apiFixture();
  await assert.rejects(updateReadme({ token: 'test-only', repository, request: (url, options) =>
    options.method === 'PATCH' ? new Response(null, { status: 403 }) : denied.request(url, options)
  }), /403/);
});
