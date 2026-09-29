export const MAX_INPUT = 64 * 1024 * 1024;

export function repositoryToSave(info, entries, known) {
  if (!entries.length || entries.some(entry => !known.has(entry.swhid)) ||
      !entries.some(entry => known.get(entry.swhid) === false)) return undefined;
  return projectMetadata(info).links.find(link => link.label === 'Repository')?.url;
}

export function archiveToSave(info, entries, known) {
  if (!entries.length || entries.some(entry => !known.has(entry.swhid)) ||
      !entries.some(entry => known.get(entry.swhid) === false)) return undefined;
  try {
    const url = new URL(info.archive);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !/\.(tar|tgz|tar\.(gz|bz2|lz|xz|zst)|zip|jar)$/i.test(info.filename ?? url.pathname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export async function saveArchive(archive, { submit = false, fetcher = fetch } = {}) {
  const url = new URL(archive);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A public HTTPS archive URL is required.');
  const endpoint = new URL('https://archive.softwareheritage.org/api/1/origin/save/');
  endpoint.search = new URLSearchParams({ visit_type: 'tarball', origin_url: url.href });
  const response = await fetcher(endpoint.href, {
    method: submit ? 'POST' : 'GET', credentials: 'omit', headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Save Code Now returned HTTP ${response.status}.`);
  const data = await response.json();
  const request = Array.isArray(data) ? data.reduce((latest, item) => !latest || item.id > latest.id ? item : latest, undefined) : data;
  if (!request || !Number.isSafeInteger(request.id) || request.id <= 0 || request.origin_url !== url.href ||
      request.visit_type !== 'tarball' || !['accepted', 'pending', 'rejected'].includes(request.save_request_status)) {
    throw new Error('Save Code Now returned no matching request.');
  }
  return { id: request.id, status: request.save_request_status, task: request.save_task_status,
    url: `https://archive.softwareheritage.org/api/1/origin/save/${request.id}/` };
}

export function projectMetadata(info) {
  const links = [];
  for (const [key, label] of [['repository', 'Repository'], ['homepage', 'Homepage']]) {
    try {
      const url = new URL(info[key]);
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) links.push({ label, url: url.href });
    } catch { /* Missing or invalid metadata link. */ }
  }
  return { links, description: typeof info.description === 'string' ? info.description.trim() : '',
    keywords: [...new Set((Array.isArray(info.keywords) ? info.keywords : []).filter(word => typeof word === 'string' && word.trim()).map(word => word.trim()))] };
}

export function proxyURL(template, url, base = globalThis.location?.href) {
  if (!template.includes('{url}')) throw new Error('Proxy URL must contain {url}, replaced with the encoded archive URL.');
  const result = new URL(template.replace('{url}', encodeURIComponent(url)), base);
  if (!['http:', 'https:'].includes(result.protocol)) throw new Error('Proxy must use HTTP or HTTPS.');
  return result.href;
}

export async function fetchWithProxy(url, options, proxy, fetcher = fetch) {
  try { return { response: await fetcher(url, options), viaProxy: false }; }
  catch (error) {
    if (!proxy) throw error;
    const response = await fetcher(proxyURL(proxy, url), { method: 'GET', credentials: 'omit', signal: options.signal });
    return { response, viaProxy: true };
  }
}

async function limitedBytes(response) {
  if (!response.ok) throw new Error(`Archive download returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_INPUT) throw new Error('Archive exceeds 64 MiB.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INPUT) throw new Error('Archive exceeds 64 MiB.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function downloadArchive(url, proxy = '', fetcher = fetch) {
  const options = { credentials: 'omit', signal: AbortSignal.timeout(60000) };
  let response;
  let viaProxy = false;
  try { response = await fetcher(url, options); }
  catch (error) {
    // Fetch does not distinguish CORS rejection from a network failure.
    if (!proxy) throw new Error(`Direct archive fetch failed (CORS or network). Configure a proxy or upload the archive. ${error.message}`);
    response = await fetcher(proxyURL(proxy, url), { ...options, signal: AbortSignal.timeout(60000) });
    viaProxy = true;
  }
  return { bytes: await limitedBytes(response), viaProxy };
}

export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return unit === 0 ? `${bytes} B` : `${(bytes / 1024 ** unit).toFixed(2)} ${units[unit]} (${bytes.toLocaleString('en-US')} bytes)`;
}

export function formatDuration(ms) {
  return ms < 1000 ? `${Number(ms.toFixed(ms < 10 ? 1 : 0))} ms` : `${Number((ms / 1000).toFixed(2))} s`;
}

export function inspectTree(entries) {
  const contents = new Map();
  const modes = new Map();
  for (const entry of entries) {
    modes.set(entry.mode, (modes.get(entry.mode) ?? 0) + 1);
    if (entry.type === 'directory') continue;
    if (!contents.has(entry.swhid)) contents.set(entry.swhid, []);
    contents.get(entry.swhid).push(entry);
  }
  const duplicates = new Map([...contents].filter(([, paths]) => paths.length > 1));
  const repeatedPaths = [...duplicates.values()].reduce((total, paths) => total + paths.length - 1, 0);
  return { contents, modes, duplicates, repeatedPaths };
}

export const KNOWN_BATCH_SIZE = 500;
export const KNOWN_URL = '/api/swh/known';

export async function lookupKnown(entries, { known = new Map(), fetcher = fetch, onBatch = () => {} } = {}) {
  const ids = [...new Set(entries.map(entry => entry.swhid))];
  const pending = ids.filter(id => !known.has(id));
  for (let offset = 0; offset < pending.length; offset += KNOWN_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + KNOWN_BATCH_SIZE);
    const response = await fetcher(KNOWN_URL, {
      method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      throw new Error(`Software Heritage returned HTTP ${response.status}.${retry ? ` Retry after ${retry}.` : ' Retry later.'}`);
    }
    const data = await response.json();
    if (batch.some(id => typeof data?.[id]?.known !== 'boolean')) throw new Error('Software Heritage returned an incomplete or invalid response.');
    for (const id of batch) known.set(id, data[id].known);
    onBatch(known, ids.filter(id => known.has(id)).length, ids.length);
  }
  return known;
}

export function knownCoverage(entries, known) {
  return Object.fromEntries(['content', 'directory'].map(type => {
    const ids = new Set(entries.filter(entry => type === 'directory' ? entry.type === 'directory' : entry.type !== 'directory').map(entry => entry.swhid));
    const checked = [...ids].filter(id => known.has(id)).length;
    const count = [...ids].filter(id => known.get(id) === true).length;
    return [type, { total: ids.size, checked, known: count, unknown: checked - count,
      unchecked: ids.size - checked, percent: ids.size ? 100 * count / ids.size : 100 }];
  }));
}

export function timingPhases(timings) {
  const labels = { metadata: 'Registry metadata', download: 'Archive download', read: 'Local file read', wasmDownload: 'Engine download', wasmStartup: 'Engine startup', hashing: 'SWHID generation', render: 'Display' };
  const phases = Object.entries(labels).filter(([key]) => timings[key] !== undefined)
    .map(([key, label]) => ({ key, label, duration: timings[key], network: ['metadata', 'download', 'wasmDownload'].includes(key) }));
  const measured = phases.reduce((sum, phase) => sum + phase.duration, 0);
  phases.push({ key: 'overhead', label: 'Worker / other', duration: Math.max(0, timings.total - measured), network: false });
  const total = Math.max(timings.total, measured);
  let start = 0;
  return phases.map(phase => { const share = total ? phase.duration / total * 100 : 0; const result = { ...phase, start, share }; start += share; return result; });
}

export function swhidURL(id) {
  return `https://archive.softwareheritage.org/${encodeURIComponent(id)}/`;
}

export function canLoadPackage(name, busy, hasArchive = false) {
  return !busy && (hasArchive || name.trim().length > 0);
}
