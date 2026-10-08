'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createBridge, bypass, explicitRoute, download } = require('../cli-network');
const { release } = require('../uv-release');
const { createResolver } = require('../native-resolver');

async function server(t, handler) {
  const sockets = new Set();
  const value = http.createServer();
  value.on('connect', handler);
  value.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  });
  value.listen(0, '127.0.0.1'); await once(value, 'listening');
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => value.close(resolve)); });
  return { value, route: { kind: 'http', host: `127.0.0.1:${value.address().port}` } };
}
async function bridge(t, options) {
  const value = await createBridge(options);
  t.after(() => value.close()); return value;
}
async function connect(t, bridge, target, authenticated = true) {
  const url = new URL(bridge.environment.HTTPS_PROXY);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  socket.on('error', () => {}); socket.setTimeout(3000, () => socket.destroy(new Error('test timeout')));
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const auth = authenticated ? 'Proxy-Authorization: Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64') + '\r\n' : '';
  const response = new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = chunk => {
      received = Buffer.concat([received, chunk]); const end = received.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.pause(); socket.removeListener('data', onData); socket.removeListener('error', reject);
      if (end + 4 < received.length) socket.unshift(received.subarray(end + 4));
      resolve({ socket, headers: received.subarray(0, end).toString() });
    };
    socket.on('data', onData); socket.once('error', reject);
  });
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  return response;
}
async function receive(socket) { const data = once(socket, 'data'); socket.resume(); return (await data)[0]; }

test('unauthenticated local callers are rejected without resolving routes', async t => {
  let calls = 0;
  const local = await bridge(t, { resolve: async () => { calls++; return [{ kind: 'direct' }]; } });
  const result = await connect(t, local, 'example.invalid:443', false);
  assert.match(result.headers, /^HTTP\/1.1 407/); assert.equal(calls, 0);
});

test('per-destination routing passes CONNECT without local DNS or credential leakage', async t => {
  const received = [];
  const upstream = await server(t, (request, socket) => {
    received.push([request.url, request.headers['proxy-authorization']]);
    socket.write('HTTP/1.1 200 OK\r\n\r\n'); socket.pipe(socket);
  });
  const urls = [];
  const local = await bridge(t, { resolve: async url => { urls.push(url); return [upstream.route]; } });
  for (const name of ['python.invalid', 'packages.invalid']) {
    const result = await connect(t, local, `${name}:443`);
    assert.match(result.headers, /^HTTP\/1.1 200/);
    const data = receive(result.socket); result.socket.write('hello'); assert.equal((await data).toString(), 'hello'); result.socket.destroy();
  }
  assert.deepEqual(urls, ['https://python.invalid/', 'https://packages.invalid/']);
  assert.deepEqual(received, [['python.invalid:443', undefined], ['packages.invalid:443', undefined]]);
});

test('upstream Basic authentication challenge retries once with credentials', async t => {
  const expected = 'Basic ' + Buffer.from('user:password').toString('base64');
  let calls = 0;
  const upstream = await server(t, (request, socket) => {
    calls++;
    if (request.headers['proxy-authorization'] !== expected) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n');
    } else socket.write('HTTP/1.1 200 OK\r\n\r\n');
  });
  const local = await bridge(t, { resolve: async () => [upstream.route], authorization: async (_, challenge) => challenge ? expected : undefined });
  assert.match((await connect(t, local, 'private.invalid:443')).headers, /^HTTP\/1.1 200/);
  assert.equal(calls, 2);
});

test('failed routes do not silently fall back to direct connections', async t => {
  const upstream = await server(t, (_, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  const local = await bridge(t, { resolve: async () => [upstream.route] });
  assert.match((await connect(t, local, '127.0.0.1:80')).headers, /^HTTP\/1.1 502/);
  assert.match(local.diagnostic(), /403/);
});

test('ordered PAC fallback uses the next explicitly selected proxy', async t => {
  const failed = await server(t, (_, socket) => socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'));
  const good = await server(t, (_, socket) => socket.write('HTTP/1.1 200 OK\r\n\r\n'));
  const local = await bridge(t, { resolve: async () => [failed.route, good.route] });
  assert.match((await connect(t, local, 'unresolved.invalid:443')).headers, /^HTTP\/1.1 200/);
});

test('direct route transports bytes and close tears down the tunnel', async t => {
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const local = await createBridge({ resolve: async () => [{ kind: 'direct' }] });
  try {
    const { socket, headers } = await connect(t, local, `127.0.0.1:${echo.address().port}`);
    assert.match(headers, /^HTTP\/1.1 200/);
    const data = receive(socket); socket.write('payload'); assert.equal((await data).toString(), 'payload');
    const closed = once(socket, 'close'); await local.close(); socket.resume(); await closed;
  } finally { await new Promise(resolve => echo.close(resolve)); }
});

test('environment contains local credentials only and redacts them', async t => {
  const local = await bridge(t, { resolve: async () => [] });
  const address = new URL(local.environment.HTTPS_PROXY);
  assert.equal(address.hostname, '127.0.0.1'); assert.equal(local.environment.NO_PROXY, '');
  assert.equal(local.environment.http_proxy, local.environment.HTTPS_PROXY);
  assert.ok(!local.redact(address.href).includes(address.password));
});

test('VS Code exclusions and explicit proxy protocols are retained', () => {
  assert.ok(bypass(new URL('https://sub.example.org'), ['.example.org']));
  assert.ok(!bypass(new URL('https://notexample.org'), ['.example.org']));
  assert.ok(!bypass(new URL('https://example.org'), ['example.org:80']));
  assert.equal(explicitRoute('socks5://127.0.0.1:1080').kind, 'socks');
  assert.throws(() => explicitRoute('ftp://proxy'));
});

test('native OS resolver loads on the running platform', async () => {
  const resolver = createResolver();
  try { assert.ok(Array.isArray(await resolver.resolve('https://localhost/'))); }
  finally { resolver.close(); }
});

test('uv archives are selected for every supported platform and cannot downgrade to HTTP', async () => {
  assert.deepEqual(release('darwin', 'arm64'), { name: 'uv-aarch64-apple-darwin', extension: '.tar.gz' });
  assert.equal(release('linux', 'x64').name, 'uv-x86_64-unknown-linux-musl');
  assert.equal(release('win32', 'x64').extension, '.zip');
  assert.throws(() => release('linux', 'mips'));
  await assert.rejects(download('http://example.invalid', '/unused', { onCancellationRequested: () => ({ dispose() {} }) }), /HTTPS/);
});
