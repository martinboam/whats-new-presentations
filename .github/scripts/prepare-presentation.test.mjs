import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validateInputs, downloadSource, syncDraftAsset, preparePresentation } from './prepare-presentation.mjs';

const inputs = {
  request_id: randomUUID(), tag: 'Copilot-2026-10', title: 'October Copilot',
  filename: 'october.pptx', size: '4', source_etag: '"etag"',
  source_url: 'https://example.blob.core.windows.net/whatsnewcopilot/october.pptx', notes: 'Highlights'
};

test('worker validates destination, source container, filenames, tags, and size', () => {
  validateInputs(inputs, 'martinboam/whats-new-presentations');
  validateInputs({ ...inputs, tag: 'copilot-2026-10-r10' }, 'martinboam/whats-new-presentations');
  validateInputs({ ...inputs, tag: 'copilot-2026-03-special-frontier' }, 'martinboam/whats-new-presentations');
  validateInputs({ ...inputs, tag: 'copilot-2026-03-special-frontier-r10' }, 'martinboam/whats-new-presentations');
  assert.throws(() => validateInputs({ ...inputs, tag: 'copilot-2026-03-special-frontier-r1' },
    'martinboam/whats-new-presentations'));
  const descriptiveName = "What's New in Copilot (October 2026).pptx";
  validateInputs({ ...inputs, filename: descriptiveName,
    source_url: `https://example.blob.core.windows.net/whatsnewcopilot/${encodeURIComponent(descriptiveName)}` },
  'martinboam/whats-new-presentations');
  for (const changes of [
    { source_url: 'https://evil.test/october.pptx' },
    { source_url: inputs.source_url.replace('whatsnewcopilot', 'whatsnewteams') },
    { source_url: `${inputs.source_url}?secret=token` },
    { size: '0' }, { size: String(2 * 1024 ** 3) },
    { filename: '../secret.pptx' }, { tag: 'anything' }
  ]) assert.throws(() => validateInputs({ ...inputs, ...changes }, 'martinboam/whats-new-presentations'));
  assert.throws(() => validateInputs(inputs, 'other/repo'));
});

test('download checks ETag, exact bytes, and SHA-256 without buffering the file', async () => {
  const path = join(tmpdir(), `presentation-test-${randomUUID()}`);
  try {
    const digest = await downloadSource(inputs, path, async (url, options) => {
      assert.equal(options.headers['If-Match'], inputs.source_etag);
      assert.equal(options.headers['x-ms-version'], '2023-11-03');
      assert.equal(options.redirect, 'error');
      return new Response('test', { headers: { etag: '"etag"' } });
    });
    assert.equal(digest, 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08');
    assert.equal(await readFile(path, 'utf8'), 'test');
  } finally {
    await rm(path, { force: true });
  }
});

test('changed ETag and oversized bodies fail explicitly', async () => {
  const path = join(tmpdir(), `presentation-test-${randomUUID()}`);
  try {
    await assert.rejects(downloadSource(inputs, path, async () =>
      new Response('test', { headers: { etag: '"changed"' } })), /source changed/);
    await assert.rejects(downloadSource(inputs, path, async () =>
      new Response('too large', { headers: { etag: '"etag"' } })), /exceeds/);
  } finally {
    await rm(path, { force: true });
  }
});

test('identical assets skip uploading; published releases are never replaced', async () => {
  const asset = { name: inputs.filename, digest: 'sha256:test', size: 4, state: 'uploaded' };
  const args = { github: () => { throw new Error('Should not call GitHub'); },
    inputs, path: 'unused', digest: asset.digest };
  assert.equal(await syncDraftAsset({ ...args, release: { draft: true, assets: [asset] } }), asset);
  await assert.rejects(syncDraftAsset({ ...args, release: { draft: false, assets: [asset] } }), /Published/);
});

test('replacement uploads and verifies before deleting the old draft asset', async () => {
  const path = join(tmpdir(), `presentation-test-${randomUUID()}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, 'test');
  const calls = [];
  const old = { id: 2, name: inputs.filename };
  try {
    await syncDraftAsset({
      inputs, path, digest: 'sha256:test', release: { id: 1, draft: true, assets: [old] },
      github: async (route, options = {}) => {
        calls.push({ route, options });
        if (options.upload) {
          options.body.destroy();
          return { id: 3, size: 4, digest: 'sha256:test', state: 'uploaded' };
        }
        if (route === 'releases/1') return { draft: true };
        return {};
      }
    });

    assert.equal(calls[0].options.upload, true);
    assert.equal(calls[1].route, 'releases/1');
    assert.equal(calls[2].options.method, 'DELETE');
    assert.equal(calls[3].options.method, 'PATCH');
  } finally {
    await rm(path, { force: true });
  }
});

test('complete worker flow reuses the existing draft and transfers verified bytes without publishing', async () => {
  const calls = [];
  const release = { id: 1, draft: true, tag_name: 'Copilot-2026-10', assets: [],
    html_url: 'https://github.com/martinboam/whats-new-presentations/releases/tag/Copilot-2026-10' };
  const digest = 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const result = await preparePresentation({ ...inputs, tag: 'copilot-2026-10', request_id: randomUUID() }, {
    token: 'test-only',
    repository: 'martinboam/whats-new-presentations',
    request: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === inputs.source_url) return new Response('test', { headers: { etag: inputs.source_etag } });
      if (url.includes('/releases?')) return Response.json([release]);
      if (url.includes('uploads.github.com')) {
        const chunks = [];
        for await (const chunk of options.body) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), 'test');
        const name = new URL(url).searchParams.get('name');
        release.assets = [{ id: 3, name, size: 4, state: 'uploaded', digest }];
        return Response.json(release.assets[0]);
      }
      if (url.endsWith('/releases/assets/3')) {
        release.assets[0].name = JSON.parse(options.body).name;
        return Response.json(release.assets[0]);
      }
      if (options.method === 'PATCH') {
        assert.equal(JSON.parse(options.body).draft, undefined);
        assert.equal(JSON.parse(options.body).tag_name, inputs.tag);
      }
      return Response.json(release);
    }
  });
  assert.equal(result.release.tag_name, 'Copilot-2026-10');
  assert.equal(result.asset.name, inputs.filename);
  assert.equal(result.asset.digest, digest);
  assert.equal(release.draft, true);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});
