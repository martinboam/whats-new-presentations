import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'martinboam/whats-new-presentations';

export function validateInputs(inputs, repository) {
  if (repository !== REPOSITORY) throw new Error('Unexpected publishing repository.');
  if (!/^[0-9a-f-]{36}$/i.test(inputs.request_id)) throw new Error('Invalid request ID.');
  if (!/^(copilot|teams|agent365)-\d{4}-(0[1-9]|1[0-2])(?:-r[2-9]\d*)?$/i.test(inputs.tag)) {
    throw new Error('Invalid release tag.');
  }
  if (!/^[a-zA-Z0-9._ -]+\.(pptx?|pdf)$/i.test(inputs.filename)) throw new Error('Invalid filename.');
  const url = new URL(inputs.source_url);
  const containers = { copilot: 'whatsnewcopilot', teams: 'whatsnewteams', agent365: 'whatsnewagent365' };
  const category = inputs.tag.split('-')[0].toLowerCase();
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash ||
      decodeURIComponent(url.pathname) !== `/${containers[category]}/${inputs.filename}`) {
    throw new Error('Source must be the matching public Azure presentation blob.');
  }
  if (!Number.isSafeInteger(Number(inputs.size)) || Number(inputs.size) <= 0 ||
      Number(inputs.size) >= 2 * 1024 ** 3) throw new Error('Invalid file size.');
  if (!inputs.source_etag || !inputs.title || inputs.title.length > 200 ||
      typeof inputs.notes !== 'string' || inputs.notes.length > 50000) throw new Error('Invalid release metadata.');
}

export async function downloadSource(inputs, path, request = fetch) {
  const response = await request(inputs.source_url, {
    headers: { 'If-Match': inputs.source_etag },
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60 * 1000)
  });
  if (!response.ok || response.headers.get('etag') !== inputs.source_etag) {
    throw new Error(`Azure download failed or source changed (${response.status}).`);
  }
  let bytes = 0;
  const hash = createHash('sha256');
  const verify = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > Number(inputs.size)) return callback(new Error('Source exceeds expected size.'));
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(path, { flags: 'wx' }));
  if (bytes !== Number(inputs.size)) throw new Error('Source does not match expected size.');
  return `sha256:${hash.digest('hex')}`;
}

export async function syncDraftAsset({ github, release, inputs, path, digest }) {
  if (!release.draft) throw new Error('Published releases cannot be modified. Use a revision tag.');
  const existing = release.assets.find(asset => asset.name === inputs.filename);
  if (existing?.digest === digest && existing.size === Number(inputs.size) && existing.state === 'uploaded') {
    return existing;
  }
  const temporaryName = `${inputs.filename}.upload-${inputs.request_id}`;
  const contentType = inputs.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf'
    : inputs.filename.toLowerCase().endsWith('.pptx')
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/vnd.ms-powerpoint';
  const uploaded = await github(`releases/${release.id}/assets?name=${encodeURIComponent(temporaryName)}`, {
    method: 'POST',
    upload: true,
    headers: { 'Content-Type': contentType, 'Content-Length': inputs.size },
    body: createReadStream(path),
    duplex: 'half'
  });
  if (uploaded.size !== Number(inputs.size) || uploaded.state !== 'uploaded' ||
      (uploaded.digest && uploaded.digest !== digest)) {
    throw new Error('Uploaded attachment failed size or checksum verification.');
  }
  // Recheck before removing an old draft attachment in case someone published during transfer.
  const current = await github(`releases/${release.id}`);
  if (!current.draft) throw new Error('Release was published during transfer. Manual review is required.');
  if (existing) await github(`releases/assets/${existing.id}`, { method: 'DELETE' });
  return github(`releases/assets/${uploaded.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: inputs.filename, label: inputs.filename })
  });
}

export async function preparePresentation(inputs, { token, repository, request = fetch }) {
  validateInputs(inputs, repository);
  if (!token) throw new Error('GitHub token is required.');
  async function github(path, options = {}) {
    const { upload, ...fetchOptions } = options;
    const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    const response = await request(`${origin}/repos/${repository}/${path}`, {
      ...fetchOptions,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...options.headers
      },
      signal: AbortSignal.timeout(upload ? 10 * 60 * 1000 : 30000)
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(`GitHub request failed (${response.status}): ${error.message || response.statusText}`);
    }
    return response.status === 204 ? null : response.json();
  }
  let release;
  for (let page = 1; ; page++) {
    const releases = await github(`releases?per_page=100&page=${page}`);
    release = releases.find(item => item.tag_name.toLowerCase() === inputs.tag.toLowerCase());
    if (release || releases.length < 100) break;
  }
  if (release && !release.draft) throw new Error('Release already published. Use a revision tag.');
  const path = join(tmpdir(), `presentation-${inputs.request_id}`);
  try {
    const digest = await downloadSource(inputs, path, request);
    if (!release) {
      release = await github('releases', {
        method: 'POST',
        body: JSON.stringify({ tag_name: inputs.tag, name: inputs.title, body: inputs.notes, draft: true })
      });
    } else {
      release = await github(`releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: inputs.title, body: inputs.notes })
      });
    }
    const asset = await syncDraftAsset({ github, release, inputs, path, digest });
    console.log(`Draft ready: ${release.html_url}`);
    console.log(`Verified attachment: ${asset.name} (${asset.size} bytes, ${digest})`);
    return { release, asset };
  } finally {
    await rm(path, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  preparePresentation(JSON.parse(process.env.PRESENTATION_INPUTS || '{}'), {
    token: process.env.GH_TOKEN,
    repository: process.env.GH_REPOSITORY
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
