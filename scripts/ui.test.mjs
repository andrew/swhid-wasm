import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

async function until(read, description) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const requests = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  });
  return {
    errors, requests,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

test('browser uploads an archive, runs the WASM worker, and displays independently computed SWHIDs', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swhid-ui-'));
  let server, chrome, client;
  let serverLog = '', chromeLog = '';
  try {
    await mkdir(join(directory, 'package'));
    await writeFile(join(directory, 'package/hello.txt'), 'hello\n', { mode: 0o644 });
    const archive = join(directory, 'package.tar');
    execFileSync('tar', ['-cf', archive, '-C', directory, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const hash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest();
    const content = hash('blob', Buffer.from('hello\n'));
    const root = `swh:1:dir:${hash('tree', Buffer.concat([Buffer.from('100644 hello.txt\0'), content])).toString('hex')}`;
    server = spawn('./build/server', ['-port', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', data => { serverLog += data; });
    server.on('error', error => { serverLog += error.message; });
    const origin = await until(() => {
      if (server.exitCode !== null) throw new Error(serverLog);
      return serverLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    }, 'server startup');
    const binary = process.env.CHROME_BIN ?? (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
    chrome = spawn(binary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', data => { chromeLog += data; });
    let chromeError;
    chrome.on('error', error => { chromeError = error; });
    const port = await until(async () => {
      if (chromeError) throw chromeError;
      if (chrome.exitCode !== null) throw new Error(chromeLog);
      try { return (await readFile(join(directory, 'chrome/DevToolsActivePort'), 'utf8')).split('\n')[0]; }
      catch { return undefined; }
    }, 'Chrome startup');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await client.call('Runtime.enable');
    await client.call('Network.enable');
    const evaluate = async expression => {
      const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await client.call('Page.navigate', { url: origin });
    await until(() => evaluate(`Boolean(document.querySelector('#archive')?.onchange)`), 'UI startup');
    await evaluate(`document.querySelector('#auto-check').checked = false; document.querySelector('#strip').checked = true`);
    const document = await client.call('DOM.getDocument');
    const input = await client.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#archive' });
    await client.call('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [archive] });
    await until(() => evaluate(`!document.querySelector('#load').disabled && !document.querySelector('#result-content').hidden`), 'archive hashing');
    const result = await evaluate(`({root: document.querySelector('#coverage a').getAttribute('aria-label'), tree: document.querySelector('#tree').textContent, status: document.querySelector('#status').textContent})`);
    assert.equal(result.root, `Package root ${root}`);
    assert.match(result.tree, /hello\.txt/);
    assert.equal(result.status, '');
    assert.ok(client.requests.every(request => request.method === 'GET'), 'local archives must not be uploaded');
    assert.deepEqual(client.errors, []);
    if (process.env.LIVE_REGISTRY === '1') {
      await evaluate(`document.querySelector('#clear-archive').click(); document.querySelector('#package').value = 'is-number'; document.querySelector('#version').value = '7.0.0'; document.querySelector('#package-form').requestSubmit()`);
      await until(() => evaluate(`!document.querySelector('#load').disabled && !document.querySelector('#result-content').hidden`), 'live npm package');
      const live = await evaluate(`({root: document.querySelector('#coverage a').getAttribute('aria-label'), title: document.querySelector('#title').textContent, tree: document.querySelector('#tree').textContent})`);
      assert.match(live.title, /is-number/);
      assert.match(live.tree, /package\.json/);
      assert.match(live.root, /^Package root swh:1:dir:[0-9a-f]{40}$/);
      console.log(JSON.stringify(live));
      await evaluate(`document.querySelector('#check-known').click()`);
      await until(() => evaluate(`!document.querySelector('#check-known').disabled`), 'Software Heritage lookup');
      console.log(await evaluate(`document.querySelector('#known-status').textContent`));
      assert.equal(await evaluate(`document.querySelector('#check-known').dataset.complete`), 'true');
    }
  } finally {
    client?.close();
    if (chrome) await stop(chrome);
    if (server) await stop(server);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
