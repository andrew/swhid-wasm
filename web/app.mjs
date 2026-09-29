import { downloadArchive, MAX_INPUT, formatBytes, formatDuration, inspectTree, lookupKnown, knownCoverage, timingPhases, swhidURL, canLoadPackage, projectMetadata, repositoryToSave, archiveToSave, saveArchive } from './core.mjs';
import { resolvePackage } from './resolve.mjs';
import { indexTree, treeView } from './tree.mjs';

const $ = id => document.getElementById(id);
let current;
let busy = false;
let selectedArchive;
let packageName = $('package').value;
function status(message, error = false) { $('status').hidden = !message; $('status').textContent = message; $('status').classList.toggle('error', error); }
function setBusy(value) {
  busy = value;
  $('results').setAttribute('aria-busy', String(value));
  document.querySelectorAll('#package-form input, #package-form select, #package-form button, #archive, #strip, #check-known').forEach(el => { el.disabled = value; });
  $('load').disabled = !canLoadPackage($('package').value, busy, Boolean(selectedArchive));
}
function element(tag, text) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; }
let infoSequence = 0;
function infoButton(text, label) {
  const wrap = element('span'); wrap.className = 'info-wrap';
  const button = element('button', label); button.type = 'button'; button.className = 'tooltip-label';
  button.setAttribute('aria-label', label);
  const panel = element('span', text); panel.id = `info-${++infoSequence}`; panel.setAttribute('popover', 'auto');
  button.setAttribute('popovertarget', panel.id);
  wrap.append(button, panel); return wrap;
}
function identifier(id) {
  const container = element('span'); container.className = 'entry-id';
  const input = element('a', id); input.href = swhidURL(id); input.target = '_blank'; input.rel = 'noopener noreferrer'; input.setAttribute('aria-label', `Open ${id} in Software Heritage`); input.title = id; input.textContent = `${id.slice(0, 18)}…${id.slice(-8)}`;
  const copy = element('button', 'Copy'); copy.type = 'button';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(id); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }
    catch { status(`Clipboard unavailable. Copy this SWHID: ${id}`, true); }
  };
  container.append(input, copy); return container;
}
function knownBadge(id) {
  const badge = element('span'); badge.hidden = true;
  badge.className = 'badge preservation-state unchecked';
  badge.dataset.swhid = id;
  return badge;
}
function rowCopy(id) {
  const button = element('button', '⧉'); button.type = 'button'; button.className = 'row-copy';
  button.setAttribute('aria-label', `Copy ${id}`);
  button.onclick = async event => {
    event.preventDefault(); event.stopPropagation();
    try { await navigator.clipboard.writeText(id); button.textContent = '✓'; setTimeout(() => { button.textContent = '⧉'; }, 1500); }
    catch { status(`Clipboard unavailable. Copy this SWHID: ${id}`, true); }
  };
  return button;
}
function renderTree() {
  const list = element('ul');
  const parents = new Map([['', list]]);
  current.treeIndex = indexTree(current.tree.entries);
  current.treeRows = new Map();
  current.filtering = false;
  $('tree-filter').value = ''; $('unknown-filter').checked = false;
  $('tree-filter').hidden = current.treeIndex.nodes.get('').files <= 50;
  for (const node of current.treeIndex.order) {
    const entry = node.entry;
    if (!entry.path) continue;
    const row = element('li');
    const parent = entry.path.slice(0, entry.path.lastIndexOf('/') < 0 ? 0 : entry.path.lastIndexOf('/'));
    const directory = entry.type === 'directory';
    const details = element('details'); details.className = directory ? 'directory-entry' : 'file-entry';
    const summary = element('summary');
    const label = element(directory ? 'a' : 'span', entry.path.split('/').at(-1) + (directory ? '/' : ''));
    label.className = 'entry-name';
    if (directory) { label.href = swhidURL(entry.swhid); label.target = '_blank'; label.rel = 'noopener noreferrer'; label.title = entry.swhid; }
    const nameCell = element('span'); nameCell.className = 'entry-name-cell'; nameCell.append(label);
    summary.append(nameCell);
    const peers = current.inspection.duplicates.get(entry.swhid);
    if (peers) { const badge = element('span', `shared ×${peers.length}`); badge.className = 'badge duplicate'; nameCell.append(badge); }
    const missing = element('span'); missing.className = 'descendant-unknown'; missing.hidden = true; nameCell.append(missing);
    const size = element('small', `${directory ? `${node.files} ${node.files === 1 ? 'file' : 'files'} · ` : ''}${formatBytes(node.bytes).split(' (')[0]}`); size.className = 'entry-size';
    const tail = element('span'); tail.className = 'entry-tail';
    const state = element('span'); state.className = 'entry-state'; state.append(knownBadge(entry.swhid));
    tail.append(rowCopy(entry.swhid), size); summary.append(state, tail);
    details.append(summary);
    if (directory) {
      const children = element('ul'); details.append(children); parents.set(entry.path, children);
    } else {
      const detail = element('div'); detail.className = 'file-detail'; detail.append(identifier(entry.swhid));
      if (entry.mode !== '100644') detail.append(element('code', `mode ${entry.mode}`));
      details.append(detail);
      if (peers) details.addEventListener('toggle', () => {
        if (!details.open || details.querySelector('.peers')) return;
        const group = element('div'); group.className = 'peers'; group.append(element('p', 'Same content at:'));
        const paths = element('ul');
        for (const peer of peers) if (peer.path !== entry.path) paths.append(element('li', peer.path));
        group.append(paths); details.append(group);
      });
    }
    row.append(details); parents.get(parent).append(row);
    current.treeRows.set(entry.path, { row, details, missing });
  }
  $('tree').replaceChildren(list);
}

function filterTree() {
  if (!current?.treeIndex) return;
  const query = $('tree-filter').value;
  const unknownOnly = $('unknown-filter').checked;
  const active = Boolean(query.trim() || unknownOnly);
  if (active && !current.filtering) current.expandedPaths = new Set([...current.treeRows].filter(([, item]) => item.details.open).map(([path]) => path));
  const view = treeView(current.treeIndex, current.known, query, unknownOnly);
  for (const [path, item] of current.treeRows) {
    item.row.hidden = !view.visible.has(path);
    if (active) item.details.open = view.expanded.has(path);
    else if (current.filtering) item.details.open = current.expandedPaths.has(path);
    const count = view.unknown.get(path);
    item.missing.hidden = !count;
    item.missing.textContent = count ? `${count} unknown` : '';
  }
  current.filtering = active;
  $('tree-empty').hidden = [...current.treeRows.keys()].some(path => view.visible.has(path));
}
function render() {
  const { tree, info } = current;
  $('results').hidden = false; $('result-content').hidden = false; $('results').classList.remove('pending');
  $('title').textContent = `${info.name} ${info.version ?? ''}`;
  $('metadata').replaceChildren(element('code', info.purl ?? 'Local archive'));
  if (info.downloadNote) $('metadata').append(infoButton(info.downloadNote + (info.metadataViaProxy ? '. Registry metadata fetched through the proxy' : '') + '. Extraction and hashing run only in your browser.', info.downloadNote.replace('archive ', '')));
  $('root-choice').textContent = tree.stripped
    ? `Removed wrapper: ${tree.stripped}/. Full archive root: ${tree.archiveRoot}`
    : `Using the full archive root: ${tree.archiveRoot}`;
  const rootIdentifier = identifier(tree.root);
  rootIdentifier.querySelector('a').textContent = `${tree.root.slice(0, 18)}…${tree.root.slice(-8)}`;
  rootIdentifier.querySelector('a').setAttribute('aria-label', `Package root ${tree.root}`);
  $('coverage').replaceChildren(rootIdentifier);
  const files = tree.entries.filter(e => e.type !== 'directory');
  const dirs = tree.entries.filter(e => e.type === 'directory');
  $('object-counts').replaceChildren();
  $('object-counts').textContent = `${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'} · ${current.inspection.contents.size.toLocaleString()} distinct contents · ${dirs.length.toLocaleString()} ${dirs.length === 1 ? 'directory' : 'directories'}`;
  renderInspection();
  renderProject();
  renderTree();
  renderKnown();
}
function renderProject() {
  const { links, description, keywords } = projectMetadata(current.info);
  const panel = $('project-panel'); panel.replaceChildren();
  const available = Boolean(links.length || description || keywords.length);
  $('project-summary').hidden = !available;
  if (!available) { panel.hidden = true; $('project-summary').setAttribute('aria-expanded', 'false'); return; }
  if (description) panel.append(element('p', description));
  const list = element('dl');
  for (const { label, url } of links) {
    const link = element('a', url); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const value = element('dd'); value.append(link); list.append(element('dt', label), value);
  }
  if (keywords.length) {
    const words = element('dd'); words.className = 'project-keywords';
    for (const keyword of keywords) words.append(element('span', keyword));
    list.append(element('dt', 'Keywords'), words);
  }
  if (list.children.length) panel.append(list);
}
function renderInspection() {
  const { modes, duplicates, repeatedPaths } = current.inspection;
  const names = { '100644': 'Regular files', '100755': 'Executable files', '120000': 'Symlinks', '40000': 'Directories' };
  const counts = $('mode-counts'); counts.replaceChildren();
  for (const [mode, count] of modes) counts.append(element('dt', `${names[mode] ?? mode} · ${mode}`), element('dd', String(count)));
  $('duplicate-summary').hidden = duplicates.size === 0;
  if (!duplicates.size) $('duplicates-panel').hidden = true;
  $('duplicate-summary').textContent = `Duplicate contents · ${duplicates.size} groups`;
  $('duplicate-counts').textContent = `${repeatedPaths} repeated paths across ${duplicates.size} groups.`;
  const groups = $('duplicate-groups'); groups.replaceChildren();
  if (!duplicates.size) groups.append(element('p', 'Every content object in this package is unique.'));
  for (const [id, entries] of duplicates) {
    const group = element('details');
    group.append(element('summary', `${entries.length} paths · ${entries[0].path}`), identifier(id));
    const paths = element('ul');
    for (const entry of entries) paths.append(element('li', `${entry.path} (${entry.mode})`));
    group.append(paths); groups.append(group);
  }
}
function renderStats() {
  const { tree, archiveBytes, timings } = current;
  const arrow = element('span', ' → ');
  arrow.title = `Archive: ${archiveBytes.toLocaleString()} bytes → extracted contents: ${tree.unpackedBytes.toLocaleString()} bytes, including hard links and symlink targets, without filesystem overhead.`;
  $('sizes').replaceChildren(document.createTextNode(formatBytes(archiveBytes).split(' (')[0]), arrow, document.createTextNode(formatBytes(tree.unpackedBytes).split(' (')[0]));
  $('timings-heading').textContent = `${formatDuration(timings.total)} overall`;
  const phases = timingPhases(timings);
  $('stats').replaceChildren(); $('timing-bar').replaceChildren();
  const tooltip = element('span'); tooltip.id = 'phase-tooltip'; tooltip.setAttribute('role', 'tooltip'); tooltip.hidden = true;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 100 10'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-label', 'Time by phase');
  $('timing-bar').append(svg, tooltip);
  for (const phase of phases) {
    const item = element('span', `${phase.label} ${formatDuration(phase.duration)}`);
    item.className = `phase phase-${phase.key} ${phase.network ? 'network' : 'local'}`;
    $('stats').append(item);
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    segment.setAttribute('x', phase.start); segment.setAttribute('width', phase.share); segment.setAttribute('height', '10');
    segment.setAttribute('class', item.className);
    segment.setAttribute('tabindex', '0'); segment.setAttribute('role', 'img');
    segment.setAttribute('aria-label', item.textContent); segment.setAttribute('aria-describedby', 'phase-tooltip');
    const show = () => { tooltip.textContent = item.textContent; tooltip.hidden = false; };
    const hide = () => { tooltip.hidden = true; };
    segment.addEventListener('mouseenter', show); segment.addEventListener('focus', show);
    segment.addEventListener('mouseleave', hide); segment.addEventListener('blur', hide);
    segment.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
    svg.append(segment);
  }
  if (timings.swhLookup !== undefined) $('stats').append(element('span', `SWH lookup ${formatDuration(timings.swhLookup)} (separate)`));
}
function hash(name, bytes, stripRoot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/hash-worker.mjs', { type: 'module' });
    const timeout = setTimeout(() => finish(new Error('Hashing exceeded two minutes.')), 120000);
    function finish(error, result) { clearTimeout(timeout); worker.terminate(); error ? reject(error) : resolve(result); }
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
    worker.onerror = event => finish(new Error(event.message));
    worker.postMessage({ name, bytes: bytes.buffer, stripRoot }, [bytes.buffer]);
  });
}
async function run(load) {
  if (busy) return;
  const started = performance.now();
  setBusy(true); current = undefined; $('results').hidden = false; $('result-content').hidden = true; $('results').classList.add('pending'); status('Loading package…');
  $('check-known').dataset.complete = '';
  $('check-known').setAttribute('aria-label', 'Check Software Heritage');
  $('known-status').textContent = 'Not checked. Only SWHIDs are sent through the local relay to Software Heritage.';
  try {
    const { info, bytes, stripRoot, timings } = await load();
    const archiveBytes = bytes.byteLength;
    status('Unpacking and calculating SWHIDs locally…');
    const hashed = await hash(info.filename, bytes, stripRoot);
    current = { info, tree: hashed.result, inspection: inspectTree(hashed.result.entries), known: new Map(), archiveBytes, timings: { ...timings, ...hashed.timings } };
    const renderStart = performance.now();
    render();
    current.timings.render = performance.now() - renderStart;
    current.timings.total = performance.now() - started;
    renderStats();
    status('');
  } catch (error) { status(error.message, true); }
  finally { setBusy(false); }
  if (current && $('auto-check').checked) await $('check-known').onclick();
}
$('package-form').onsubmit = event => {
  event.preventDefault();
  if (selectedArchive) { local(selectedArchive); return; }
  run(async () => {
    status('Resolving registry metadata…');
    const metadataStart = performance.now();
    const info = await resolvePackage($('ecosystem').value, $('package').value, $('version').value, $('proxy').value.trim());
    const metadata = performance.now() - metadataStart;
    status('Downloading published archive…');
    const downloadStart = performance.now();
    const { bytes, viaProxy } = await downloadArchive(info.archive, $('proxy').value.trim());
    info.downloadNote = viaProxy ? 'archive fetched through proxy' : 'archive fetched directly';
    return { info, bytes, stripRoot: info.stripRoot, timings: { metadata, download: performance.now() - downloadStart } };
  });
};
function local(file) {
  if (!file || busy) return;
  if (!selectedArchive) packageName = $('package').value;
  selectedArchive = file; $('package').value = file.name; $('package').readOnly = true; $('clear-archive').hidden = false;
  const stripRoot = $('strip').checked;
  run(async () => {
    if (file.size > MAX_INPUT) throw new Error('Archive exceeds 64 MiB.');
    const readStart = performance.now();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { info: { name: file.name, filename: file.name }, bytes, stripRoot, timings: { read: performance.now() - readStart } };
  });
}
$('archive').onchange = event => local(event.target.files[0]);
$('package-form').ondragover = event => { event.preventDefault(); $('package-form').classList.add('drag'); };
$('package-form').ondragleave = () => $('package-form').classList.remove('drag');
$('package-form').ondrop = event => { event.preventDefault(); $('package-form').classList.remove('drag'); local(event.dataTransfer.files[0]); };

function renderKnown() {
  const { tree, known } = current;
  const repository = repositoryToSave(current.info, tree.entries, known);
  const archive = archiveToSave(current.info, tree.entries, known);
  $('save-actions').hidden = !repository && !archive && !current.saveAttempted;
  $('save-archive').hidden = !archive && !current.saveAttempted;
  $('save-archive').disabled = Boolean(current.saveAttempted);
  $('save-refresh').hidden = !current.saveAttempted;
  $('save-refresh').disabled = Boolean(current.saveBusy);
  $('save-archive-note').hidden = !archive && !current.saveAttempted;
  $('save-status').textContent = current.saveMessage ?? '';
  $('save-request').hidden = !current.saveRequest;
  if (current.saveRequest) $('save-request').href = current.saveRequest.url;
  $('save-repository').hidden = !repository;
  $('save-repository-url').textContent = repository ?? '';
  if (repository) $('save-repository-url').href = repository;
  else $('save-repository-url').removeAttribute('href');
  const state = id => !known.has(id) ? 'Unchecked' : known.get(id) ? 'Known' : 'Unknown';
  for (const badge of document.querySelectorAll('.preservation-state')) {
    const label = state(badge.dataset.swhid);
    badge.hidden = label === 'Unchecked';
    badge.textContent = '';
    badge.title = label; badge.setAttribute('role', 'img'); badge.setAttribute('aria-label', label); badge.tabIndex = 0;
    badge.className = `badge preservation-state ${label.toLowerCase()}`;
  }
  const checked = known.size > 0;
  $('unknown-filter-label').hidden = !checked;
  $('unknown-filter').disabled = ![...known.values()].some(value => value === false);
  if ($('unknown-filter').disabled) $('unknown-filter').checked = false;
  filterTree();
  $('known-label').textContent = `tree ${known.get(tree.root) === true ? '✓' : known.get(tree.root) === false ? 'unknown' : 'unchecked'}`;
  $('known-label').hidden = !checked; $('known-coverage').hidden = !checked;
  $('check-known').textContent = checked ? '↻' : 'Check Software Heritage';
  $('check-known').classList.toggle('initial-check', !checked);
  const stats = knownCoverage(tree.entries, known);
  const dl = $('known-coverage'); dl.replaceChildren(); $('known-detail').replaceChildren();
  for (const [type, label] of [['content', 'contents'], ['directory', 'directories']]) {
    const item = stats[type];
    const box = element('span', `${item.known.toLocaleString()}/${item.total.toLocaleString()} distinct ${label}`);
    if (item.unknown || item.unchecked) {
      const pending = element('small', ` · ${item.unknown ? `${item.unknown} unknown` : ''}${item.unknown && item.unchecked ? ', ' : ''}${item.unchecked ? `${item.unchecked} unchecked` : ''}`);
      pending.className = item.unknown ? 'warning' : 'muted'; box.append(pending);
    }
    dl.append(box);
    $('known-detail').append(element('p', `${label}: ${item.percent.toFixed(1)}% known; ${item.unknown} unknown; ${item.unchecked} unchecked.`));
  }
}
$('save-archive').onclick = () => updateSave(true);
$('save-refresh').onclick = () => updateSave(false);
async function updateSave(submit) {
  const result = current;
  if (!result || result.saveBusy || (submit && result.saveAttempted)) return;
  const archive = submit ? archiveToSave(result.info, result.tree.entries, result.known) : result.info.archive;
  if (!archive) return;
  result.saveBusy = true;
  result.saveAttempted = true;
  result.saveMessage = submit ? 'Submitting archive URL…' : 'Checking save request…';
  renderKnown(); $('save-refresh').disabled = true;
  try {
    result.saveRequest = await saveArchive(archive, { submit });
    const request = result.saveRequest;
    result.saveMessage = `Request ${request.id}: ${request.status === 'pending' ? 'pending manual review' : request.status}; task ${request.task ?? 'not created'}. Re-check preservation after the task succeeds.`;
  } catch (error) {
    result.saveMessage = `${error.message} ${submit ? 'The request may have reached Software Heritage. Check its status before submitting again on the Save Code Now page.' : 'Try checking again or open Save Code Now.'}`;
  } finally {
    result.saveBusy = false;
    if (current === result) { renderKnown(); $('save-refresh').disabled = false; }
  }
}
$('check-known').onclick = async () => {
  if (busy || !current) return;
  if ($('check-known').dataset.complete === 'true') current.known.clear();
  renderKnown();
  setBusy(true);
  status('Checking Software Heritage…');
  $('check-known').setAttribute('aria-label', 'Checking Software Heritage');
  const started = performance.now();
  const lookupStatus = $('known-status');
  lookupStatus.textContent = 'Checking distinct SWHIDs in batches of up to 500…';
  try {
    await lookupKnown(current.tree.entries, { known: current.known, onBatch: (known, done, total) => {
      lookupStatus.textContent = `Checked ${done.toLocaleString()} / ${total.toLocaleString()} distinct SWHIDs…`;
      status(lookupStatus.textContent); renderKnown();
    } });
    const stats = knownCoverage(current.tree.entries, current.known);
    const allContents = stats.content.known === stats.content.total;
    const allDirectories = stats.directory.known === stats.directory.total;
    lookupStatus.textContent = allContents && allDirectories
      ? 'Package tree and all individual objects are known.'
      : allContents && current.known.get(current.tree.root) === false
        ? 'All individual contents are known, but the package tree is unknown.'
        : stats.content.known + stats.directory.known === 0
          ? 'None of the calculated objects are known.'
          : 'Only part of this package is known. Check the root and individual object coverage separately.';
    status('');
    $('check-known').dataset.complete = 'true'; $('check-known').setAttribute('aria-label', 'Checked. Check Software Heritage again');
  } catch (error) {
    lookupStatus.textContent = `Lookup stopped: ${error.message} Unchecked objects remain unchecked. Retry resumes the remaining batches.`;
    $('check-known').dataset.complete = ''; $('check-known').setAttribute('aria-label', 'Lookup failed. Retry unchecked objects'); status(lookupStatus.textContent, true);
  } finally {
    current.timings.swhLookup = (current.timings.swhLookup ?? 0) + performance.now() - started;
    renderStats(); renderKnown(); setBusy(false);

  }
};

$('choose-archive').onclick = () => $('archive').click();
$('clear-archive').onclick = () => { selectedArchive = undefined; $('archive').value = ''; $('package').value = packageName; $('package').readOnly = false; $('clear-archive').hidden = true; $('package').focus(); setBusy(busy); };
$('settings').onclick = () => { $('options').hidden = !$('options').hidden; $('settings').setAttribute('aria-expanded', String(!$('options').hidden)); };
for (const button of document.querySelectorAll('[data-panel]')) button.onclick = () => {
  const open = button.getAttribute('aria-expanded') !== 'true';
  for (const tab of document.querySelectorAll('[data-panel]')) {
    const active = tab === button && open;
    tab.setAttribute('aria-expanded', String(active)); $(tab.dataset.panel).hidden = !active;
  }
};

$('package').addEventListener('input', () => setBusy(busy));
$('timing-toggle').onclick = () => { $('timing-legend').hidden = !$('timing-legend').hidden; $('timing-toggle').setAttribute('aria-expanded', String(!$('timing-legend').hidden)); };
setBusy(false);
$('tree-filter').addEventListener('input', filterTree);
$('unknown-filter').addEventListener('change', filterTree);
