import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { downloadArchive, proxyURL, MAX_INPUT } from '../web/core.mjs';
import { indexTree, treeView } from '../web/tree.mjs';
import { createAnalyzer } from '../web/wasm.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('archive fetch tries direct first, only falls back on network failure, and caps input', async () => {
  const calls = [];
  const direct = await downloadArchive('https://registry.example/pkg.tgz', 'https://proxy.example/?url={url}', async url => {
    calls.push(url); return new Response('archive');
  });
  assert.equal(direct.viaProxy,false); assert.equal(calls.length,1);
  calls.length = 0;
  const proxied = await downloadArchive('https://registry.example/pkg.tgz', 'https://proxy.example/?url={url}', async url => {
    calls.push(url);
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return new Response('archive');
  });
  assert.equal(proxied.viaProxy,true);
  assert.equal(calls[1],'https://proxy.example/?url=https%3A%2F%2Fregistry.example%2Fpkg.tgz');
  await assert.rejects(downloadArchive('https://example.test', '', async () => new Response('', {status:404})), /404/);
  await assert.rejects(downloadArchive('https://example.test', '', async () => new Response('', {headers:{'content-length':MAX_INPUT+1}})), /64 MiB/);
  await assert.rejects(downloadArchive('https://example.test', '', async () => { throw new TypeError('Failed to fetch'); }), /CORS or network/);
  assert.throws(() => proxyURL('https://proxy.test','https://example.test'), /\{url\}/);
});

test('browser WASM archive boundary matches native for nested files, modes, links and 2520 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-hash-'));
  try {
    const folder = join(root,'package');
    await mkdir(join(folder,'bin'), {recursive:true});
    await mkdir(join(folder,'empty'));
    await writeFile(join(folder,'bin/run'), '#!/bin/sh\necho hello\n');
    await chmod(join(folder,'bin/run'),0o755);
    await symlink('bin/run',join(folder,'link'));
    for (let i=0;i<2520;i++) await writeFile(join(folder,`file-${i}.txt`),`file ${i}\n`);
    const archive = join(root,'package.tgz');
    execFileSync('tar',['-czf',archive,'-C',root,'package'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    const bytes = new Uint8Array(await readFile(archive));
    const analyze = await createAnalyzer(await readFile('build/analyzer-go.wasm'));
    const actual = analyze('package.tgz',bytes,true);
    const native = spawnSync('build/native',['package-strip','package.tgz'],{input:bytes});
    assert.equal(native.status,0,native.stderr.toString());
    assert.deepEqual(actual,JSON.parse(native.stdout));
    assert.equal(actual.entries.length,2525);
    const index = indexTree(actual.entries);
    assert.equal(index.nodes.get('').files, 2522);
    assert.equal(index.nodes.get('').bytes, actual.unpackedBytes);
    const filtered = treeView(index, new Map(), 'bin/run');
    assert.deepEqual([...filtered.expanded].sort(), ['', 'bin']);
    assert.equal(filtered.visible.size, 3);
    const expectedBytes = Buffer.byteLength('#!/bin/sh\necho hello\n') + Buffer.byteLength('bin/run')
      + Array.from({length:2520},(_,i)=>Buffer.byteLength(`file ${i}\n`)).reduce((a,b)=>a+b,0);
    assert.equal(actual.unpackedBytes,expectedBytes);
    assert.equal(actual.entries.find(e=>e.path==='bin/run').mode,'100755');
    assert.equal(actual.entries.find(e=>e.path==='link').type,'symlink');
    assert.notEqual(actual.root,actual.archiveRoot);
    const zip = join(root,'package.zip');
    execFileSync('zip',['-qry',zip,'package'],{cwd:root});
    assert.deepEqual(analyze('package.zip',new Uint8Array(await readFile(zip)),true),actual);
    const tar = join(root,'package.tar');
    execFileSync('tar',['-cf',tar,'-C',root,'package'],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    assert.deepEqual(analyze('package.tar',new Uint8Array(await readFile(tar)),true),actual);
    if (process.env.SWHID_NATIVE) {
      const expected = execFileSync(process.env.SWHID_NATIVE,['directory','-f','raw',folder],{encoding:'utf8'}).trim();
      assert.equal(actual.root,expected);
      for (const path of ['bin','empty']) {
        assert.equal(actual.entries.find(e=>e.path===path).swhid,
          execFileSync(process.env.SWHID_NATIVE,['directory','-f','raw',join(folder,path)],{encoding:'utf8'}).trim());
      }
      for (const path of ['bin/run','file-0.txt','link']) {
        const body = path === 'link' ? Buffer.from('bin/run') : await readFile(join(folder,path));
        assert.equal(actual.entries.find(e=>e.path===path).swhid,
          execFileSync(process.env.SWHID_NATIVE,['content','-f','raw'],{input:body,encoding:'utf8'}).trim());
      }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('statistics format empty, small and large sizes and durations', async () => {
  const { formatBytes, formatDuration } = await import('../web/core.mjs');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KiB (1,024 bytes)');
  assert.equal(formatBytes(7803668), '7.44 MiB (7,803,668 bytes)');
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(12.34), '12 ms');
  assert.equal(formatDuration(1234), '1.23 s');
  assert.equal(formatDuration(2), '2 ms');
  assert.equal(formatDuration(2.34), '2.3 ms');
  assert.equal(formatDuration(451), '451 ms');
  assert.equal(formatDuration(1000), '1 s');
});

test('duplicate inspection groups shared bytes across modes and counts repeated paths', async () => {
  const { inspectTree } = await import('../web/core.mjs');
  const entries = [
    {path:'',type:'directory',mode:'40000',swhid:'directory'},
    {path:'regular',type:'file',mode:'100644',swhid:'shared'},
    {path:'executable',type:'file',mode:'100755',swhid:'shared'},
    {path:'link',type:'symlink',mode:'120000',swhid:'shared'},
    {path:'unique',type:'file',mode:'100644',swhid:'unique'},
  ];
  const stats = inspectTree(entries);
  assert.equal(stats.contents.size,2);
  assert.equal(stats.duplicates.size,1);
  assert.deepEqual(stats.duplicates.get('shared').map(e=>e.path),['regular','executable','link']);
  assert.equal(stats.repeatedPaths,2);
  assert.equal(stats.modes.get('100644'),2);
  assert.equal(stats.modes.get('120000'),1);
  assert.equal(inspectTree([]).repeatedPaths,0);
});

test('known lookup batches unique SWHIDs and retains separate root and content coverage', async () => {
  const { lookupKnown, knownCoverage, KNOWN_URL } = await import('../web/core.mjs');
  const root = { type:'directory', swhid:'root' };
  const entries = [root, ...Array.from({length:1001},(_,i)=>({type:'file',swhid:`content-${i}`})), {type:'symlink',swhid:'content-0'}];
  const sizes = [];
  const progress = [];
  const known = await lookupKnown(entries,{fetcher:async (url,options)=>{
    assert.equal(url,KNOWN_URL);
    assert.equal(options.method,'POST');
    assert.equal(options.credentials,'omit');
    const ids=JSON.parse(options.body); sizes.push(ids.length);
    return json(Object.fromEntries(ids.map(id=>[id,{known:id!=='root'}])));
  },onBatch:(_map,done,total)=>progress.push([done,total])});
  assert.deepEqual(sizes,[500,500,2]);
  assert.deepEqual(progress,[[500,1002],[1000,1002],[1002,1002]]);
  const coverage=knownCoverage(entries,known);
  assert.equal(known.get('root'),false);
  assert.equal(coverage.content.percent,100);
  assert.equal(coverage.content.total,1001);
  assert.equal(coverage.directory.known,0);
  assert.equal(coverage.directory.unknown,1);
});

test('save repository action requires complete coverage with unknown objects and a safe repository URL', async () => {
  const { lookupKnown, repositoryToSave } = await import('../web/core.mjs');
  const info = { repository: 'https://github.com/jonschlinkert/is-number' };
  const entries = [{ type: 'directory', swhid: `swh:1:dir:${'a'.repeat(40)}` },
    { type: 'file', swhid: `swh:1:cnt:${'b'.repeat(40)}` }];
  const known = new Map();
  assert.equal(repositoryToSave(info, entries, known), undefined);
  await lookupKnown(entries, { known, fetcher: async (_url, options) =>
    json(Object.fromEntries(JSON.parse(options.body).map((id, i) => [id, { known: i > 0 }]))) });
  assert.equal(repositoryToSave(info, entries, known), info.repository);
  assert.equal(repositoryToSave({}, entries, known), undefined);
  assert.equal(repositoryToSave({ repository: 'javascript:alert(1)' }, entries, known), undefined);
  known.delete(entries[1].swhid);
  assert.equal(repositoryToSave(info, entries, known), undefined);
  known.set(entries[0].swhid, true); known.set(entries[1].swhid, true);
  assert.equal(repositoryToSave(info, entries, known), undefined);
  known.set(entries[1].swhid, false);
  assert.equal(repositoryToSave(info, entries, known), info.repository);
});

test('archive save submits only the public URL and reads request status without changing coverage', async () => {
  const { archiveToSave, saveArchive } = await import('../web/core.mjs');
  const info = { archive: 'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz', filename: 'is-number-7.0.0.tgz' };
  const entries = [{ type: 'directory', swhid: `swh:1:dir:${'a'.repeat(40)}` }];
  const known = new Map([[entries[0].swhid, false]]);
  assert.equal(archiveToSave(info, entries, known), info.archive);
  assert.equal(archiveToSave(info, entries, new Map()), undefined);
  assert.equal(archiveToSave({}, entries, known), undefined);
  assert.equal(archiveToSave({ ...info, filename: 'rake.gem' }, entries, known), undefined);
  const response = { id: 2508667, origin_url: info.archive, visit_type: 'tarball', save_request_status: 'pending', save_task_status: 'not created' };
  const request = await saveArchive(info.archive, { submit: true, fetcher: async (url, options) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://archive.softwareheritage.org');
    assert.equal(endpoint.searchParams.get('origin_url'), info.archive);
    assert.equal(endpoint.searchParams.get('visit_type'), 'tarball');
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    return json(response);
  } });
  assert.equal(request.status, 'pending');
  assert.equal(request.url, 'https://archive.softwareheritage.org/api/1/origin/save/2508667/');
  const updated = await saveArchive(info.archive, { fetcher: async (_url, options) => {
    assert.equal(options.method, 'GET');
    return json([{ ...response, save_request_status: 'accepted', save_task_status: 'succeeded' }, { ...response, id: 1 }]);
  } });
  assert.equal(updated.task, 'succeeded');
  assert.equal(known.get(entries[0].swhid), false);
  assert.equal((await saveArchive(info.archive, { fetcher: async () => json({ ...response, save_request_status: 'rejected' }) })).status, 'rejected');
  await assert.rejects(saveArchive(info.archive, { fetcher: async () => new Response('', { status: 403 }) }), /403/);
  await assert.rejects(saveArchive(info.archive, { fetcher: async () => json([]) }), /no matching request/);
  await assert.rejects(saveArchive(info.archive, { fetcher: async () => json({ ...response, origin_url: 'https://other.example' }) }), /no matching request/);
  await assert.rejects(saveArchive('file:///private/archive.tar'), /HTTPS/);
});

test('failed known batches remain unchecked and retry resumes only missing SWHIDs', async () => {
  const {lookupKnown,knownCoverage}=await import('../web/core.mjs');
  const entries=Array.from({length:501},(_,i)=>({type:'file',swhid:`id-${i}`}));
  const known=new Map();
  let calls=0;
  await assert.rejects(lookupKnown(entries,{known,fetcher:async (_url,options)=>{
    if(++calls===2)return new Response('',{status:429,headers:{'retry-after':'60'}});
    return json(Object.fromEntries(JSON.parse(options.body).map(id=>[id,{known:false}])));
  }}),/HTTP 429/);
  assert.equal(knownCoverage(entries,known).content.unchecked,1);
  assert.equal(knownCoverage(entries,known).content.unknown,500);
  await lookupKnown(entries,{known,fetcher:async (_url,options)=>{
    assert.deepEqual(JSON.parse(options.body),['id-500']);
    return json({'id-500':{known:true}});
  }});
  assert.equal(knownCoverage(entries,known).content.unchecked,0);
  assert.equal(knownCoverage(entries,known).content.known,1);
  const invalid=new Map();
  await assert.rejects(lookupKnown(entries.slice(0,2),{known:invalid,fetcher:async()=>json({'id-0':{known:true}})}),/incomplete/);
  assert.equal(invalid.size,0);
  await assert.rejects(lookupKnown(entries,{fetcher:async()=>{throw new TypeError('network');}}),/network/);
});

test('timing segments account for overhead and exclude later SWH lookups', async () => {
  const { timingPhases } = await import('../web/core.mjs');
  const phases = timingPhases({ metadata: 20, hashing: 60, total: 100, swhLookup: 500 });
  assert.deepEqual(phases.map(p => p.duration), [20, 60, 20]);
  assert.equal(phases.reduce((sum, p) => sum + p.share, 0), 100);
  assert.equal(phases[0].network, true);
  assert.equal(phases[1].network, false);
  assert.equal(phases.at(-1).start, 80);
  assert.ok(timingPhases({ total: 0 }).every(p => Number.isFinite(p.share)));
});

test('SWHID links preserve the complete identifier', async () => {
  const { swhidURL } = await import('../web/core.mjs');
  const id = 'swh:1:dir:fb9b2897efee5fb381d1258543fff68114c92ece';
  const url = new URL(swhidURL(id));
  assert.equal(url.origin, 'https://archive.softwareheritage.org');
  assert.equal(decodeURIComponent(url.pathname), `/${id}/`);
});

test('Load is enabled only for a package or selected archive while idle', async () => {
  const { canLoadPackage } = await import('../web/core.mjs');
  assert.equal(canLoadPackage('is-number', false), true);
  assert.equal(canLoadPackage('  ', false), false);
  assert.equal(canLoadPackage('', false, true), true);
  assert.equal(canLoadPackage('is-number', true), false);
  assert.equal(canLoadPackage('', true, true), false);
});

test('file tree sorts siblings, totals repeated paths and filters unknown descendants', () => {
  const entries = [
    { path: '', type: 'directory', swhid: 'root' },
    { path: 'A.txt', type: 'file', swhid: 'shared', size: 3 },
    { path: 'z', type: 'directory', swhid: 'dir' },
    { path: 'z/b.txt', type: 'file', swhid: 'shared', size: 3 },
    { path: 'z/a.txt', type: 'file', swhid: 'missing', size: 7 },
    { path: 'empty', type: 'directory', swhid: 'empty-dir' },
  ];
  const index = indexTree(entries);
  assert.deepEqual(index.order.map(node => node.entry.path), ['', 'empty', 'z', 'z/a.txt', 'z/b.txt', 'A.txt']);
  assert.equal(index.nodes.get('').files, 3);
  assert.equal(index.nodes.get('').bytes, 13);
  assert.equal(index.nodes.get('z').bytes, 10);
  const known = new Map([['root', true], ['dir', true], ['shared', true], ['missing', false]]);
  const view = treeView(index, known, '', true);
  assert.deepEqual([...view.visible].sort(), ['', 'z', 'z/a.txt']);
  assert.equal(view.unknown.get('z'), 1);
  assert.equal(known.get(index.nodes.get('z').entry.swhid), true);
  assert.deepEqual([...view.expanded].sort(), ['', 'z']);
  assert.deepEqual([...treeView(index, known, 'Z/B.TXT').visible].sort(), ['', 'z', 'z/b.txt']);
  assert.equal(treeView(index, known, 'b.txt', true).visible.size, 0);
  assert.equal(treeView(index, new Map(), '', true).visible.size, 0);
});

test('project metadata keeps normalized text and only navigable public links', async () => {
  const { projectMetadata } = await import('../web/core.mjs');
  assert.deepEqual(projectMetadata({ description: '  Package description ', keywords: ['fast', 'fast', '', ' local ', null],
    repository: 'https://github.com/example/project', homepage: 'javascript:alert(1)' }), {
    description: 'Package description', keywords: ['fast', 'local'],
    links: [{ label: 'Repository', url: 'https://github.com/example/project' }],
  });
  assert.deepEqual(projectMetadata({ homepage: 'https://user:secret@example.com' }).links, []);
  assert.deepEqual(projectMetadata({}), { links: [], description: '', keywords: [] });
});
