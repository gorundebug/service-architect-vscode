'use strict';
const http = require('http');
const https = require('https');
const net = require('node:net');
const fs = require('node:fs');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksClient } = require('socks');
const { createResolver } = require('./native-resolver');

const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const hopHeaders = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
function cleanHeaders(headers) {
  const omitted = new Set([...hopHeaders, ...(headers.connection || '').toLowerCase().split(',').map(x => x.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !omitted.has(key.toLowerCase())));
}
function bypass(url, entries) {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return entries.some(value => {
    value = value.trim().toLowerCase();
    if (value === '*') return true;
    const match = /^(.*?)(?::(\d+))?$/.exec(value);
    const name = match[1].replace(/^\*?\./, '');
    return name && (!match[2] || match[2] === port) && (host === name || host.endsWith('.' + name));
  });
}
function explicitRoute(value) {
  const proxy = new URL(value);
  if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:', 'socks4:', 'socks4a:'].includes(proxy.protocol)) {
    throw new Error('Unsupported proxy protocol in VS Code HTTP settings');
  }
  return { kind: proxy.protocol.startsWith('socks') ? 'socks' : 'http', host: proxy.href };
}

async function editorNetwork(vscode, context) {
  const resolver = createResolver();
  const pending = new Map();
  try {
    const bridge = await createBridge({
      resolve: async value => {
        const settings = vscode.workspace.getConfiguration('http');
        if (settings.get('proxySupport', 'on') === 'off') return [{ kind: 'direct' }];
        const exclusions = settings.get('noProxy', []);
        const entries = exclusions.length ? exclusions : (process.env.no_proxy || process.env.NO_PROXY || '').split(',');
        if (bypass(new URL(value), entries)) return [{ kind: 'direct' }];
        const manual = settings.get('proxy', '');
        return manual ? [explicitRoute(manual)] : resolver.resolve(value);
      },
      authorization: async (proxy, challenge) => {
        const settings = vscode.workspace.getConfiguration('http');
        const manual = settings.get('proxy', '');
        if (manual && new URL(manual).origin === proxy.origin) {
          const configured = settings.get('proxyAuthorization');
          if (configured && !challenge) return configured;
        }
        const key = 'cli-proxy:' + proxy.origin;
        if (!challenge) return context.secrets.get(key);
        if (!/(^|[,\s])Basic(?:\s|$)/i.test(challenge)) {
          throw new Error('The proxy requires an authentication method unavailable to this extension.');
        }
        if (!pending.has(key)) {
          pending.set(key, (async () => {
            const username = await vscode.window.showInputBox({ title: `Proxy authentication: ${proxy.host}`, prompt: 'Username', ignoreFocusOut: true });
            if (username === undefined) throw new Error('Proxy authentication cancelled');
            const password = await vscode.window.showInputBox({ title: `Proxy authentication: ${proxy.host}`, prompt: 'Password', password: true, ignoreFocusOut: true });
            if (password === undefined) throw new Error('Proxy authentication cancelled');
            const header = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
            await context.secrets.store(key, header);
            return header;
          })());
        }
        return pending.get(key);
      },
    });
    const close = bridge.close;
    bridge.close = async () => { resolver.close(); await close(); };
    return bridge;
  } catch (error) { resolver.close(); throw error; }
}

async function createBridge({ resolve, authorization = async () => undefined }) {
  const nonce = randomBytes(32).toString('hex');
  const expected = Buffer.from('Basic ' + Buffer.from(`sa:${nonce}`).toString('base64'));
  const sockets = new Set();
  const controllers = new Set();
  let closed = false;
  let lastError = '';
  const track = socket => {
    if (closed) { socket.destroy(); throw new Error('CLI setup cancelled'); }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };
  async function dial(value, signal) {
    const destination = new URL(value);
    const host = destination.hostname.replace(/^\[|\]$/g, '');
    const port = Number(destination.port || (destination.protocol === 'https:' ? 443 : 80));
    let error = new Error('No usable route in proxy settings');
    for (const route of await resolve(value)) {
      signal.throwIfAborted();
      try {
        let socket;
        if (route.kind === 'direct') {
          socket = await new Promise((accept, reject) => {
            const candidate = track(net.connect({ host, port, signal }));
            candidate.once('connect', () => accept(candidate));
            candidate.once('error', reject);
          });
        } else {
          const proxy = new URL(route.host.includes('://') ? route.host : `${route.kind === 'socks' ? 'socks5' : 'http'}://${route.host}`);
          if (route.kind === 'socks') {
            const connection = await SocksClient.createConnection({ command: 'connect', timeout: 20000,
              proxy: { host: proxy.hostname, port: Number(proxy.port || 1080), type: proxy.protocol.startsWith('socks4') ? 4 : 5,
                userId: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) }, destination: { host, port } });
            socket = track(connection.socket);
          } else if (route.kind === 'http') {
            let header = await authorization(proxy);
            for (let attempt = 0; attempt < 2; attempt++) {
              const request = new EventEmitter();
              let response;
              request.on('proxyConnect', value => { response = value; });
              const agent = new HttpsProxyAgent(proxy, { signal, headers: header ? { 'Proxy-Authorization': header } : {} });
              socket = await agent.connect(request, { host, port, secureEndpoint: false, signal });
              if (response?.statusCode === 200) { track(socket); break; }
              socket.destroy();
              if (response?.statusCode !== 407 || attempt > 0) throw new Error(`Upstream proxy returned HTTP ${response?.statusCode || 'error'}`);
              header = await authorization(proxy, String(response.headers['proxy-authenticate'] || ''));
              if (!header) throw new Error('Proxy authentication is required');
            }
          } else throw new Error('Unsupported system proxy route');
        }
        if (signal.aborted || closed) { socket.destroy(); throw new Error('CLI setup cancelled'); }
        return socket;
      } catch (reason) {
        // Do not include raw library errors: they can contain proxy URLs and passwords.
        error = new Error(signal.aborted ? 'Proxy connection cancelled or timed out' :
          reason.message.startsWith('Upstream proxy returned HTTP') ? reason.message : 'Could not connect using the selected proxy route');
      }
    }
    throw error;
  }
  const authenticated = headers => {
    const actual = Buffer.from(headers['proxy-authorization'] || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = http.createServer({ maxHeaderSize: 32768 }, async (request, response) => {
    if (!authenticated(request.headers)) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Service Architect setup"' }); response.end(); return;
    }
    let destination;
    try {
      destination = new URL(request.url);
      if (destination.protocol !== 'http:' || destination.username || destination.password) throw new Error();
    } catch { response.writeHead(400); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45000);
    const agent = new http.Agent();
    agent.createConnection = (_, callback) => { dial(destination.href, controller.signal).then(socket => callback(null, socket), callback); };
    const upstream = http.request(destination, { method: request.method, headers: cleanHeaders(request.headers), agent, signal: controller.signal }, result => {
      response.writeHead(result.statusCode, cleanHeaders(result.headers)); result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on('close', () => { controller.abort(); clearTimeout(timeout); controllers.delete(controller); agent.destroy(); });
    upstream.end();
  });
  server.on('connection', socket => {
    if (closed || sockets.size >= 128) { socket.destroy(); return; }
    track(socket);
  });
  server.on('connect', async (request, client, head) => {
    if (!authenticated(request.headers)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Service Architect setup"\r\nContent-Length: 0\r\n\r\n'); return;
    }
    let destination;
    try {
      destination = new URL('https://' + request.url);
      if (destination.username || destination.password || !destination.hostname || destination.pathname !== '/' || destination.search || destination.hash) throw new Error();
    } catch { client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    client.once('close', () => { controller.abort(); controllers.delete(controller); });
    try {
      const upstream = await dial(destination.href, controller.signal);
      clearTimeout(timer);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch (error) {
      lastError = error.message;
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    } finally { clearTimeout(timer); }
  });
  server.headersTimeout = 20000;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = `http://sa:${nonce}@127.0.0.1:${server.address().port}`;
  return {
    environment: Object.fromEntries([...proxyKeys.map(key => [key, address]), ['NO_PROXY', ''], ['no_proxy', '']]),
    redact: value => String(value).replaceAll(nonce, '[redacted]').replaceAll(expected.toString(), '[redacted]'),
    diagnostic: () => lastError,
    close: async () => {
      closed = true;
      controllers.forEach(controller => controller.abort());
      sockets.forEach(socket => socket.destroy());
      await new Promise(accept => server.close(accept));
    },
  };
}

async function download(url, file, token) {
  const controller = new AbortController();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    if (token.isCancellationRequested) throw new Error('CLI setup cancelled');
    for (let redirects = 0; redirects <= 5; redirects++) {
      const address = new URL(url);
      if (address.protocol !== 'https:') throw new Error('uv downloads must use HTTPS');
      const response = await new Promise((accept, reject) => {
        // VS Code patches this public API with its proxy and certificate handling.
        const request = https.get(address, { signal: controller.signal }, accept);
        request.once('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location) throw new Error('Invalid uv download redirect');
        url = new URL(response.headers.location, url).href;
        continue;
      }
      if (response.statusCode !== 200) { response.resume(); throw new Error(`Cannot download uv: HTTP ${response.statusCode}`); }
      let size = 0;
      const bounded = new Transform({ transform(chunk, _, callback) {
        size += chunk.length;
        callback(size > 64 * 1024 * 1024 ? new Error('Unexpected uv release size') : null, chunk);
      } });
      await pipeline(response, bounded, fs.createWriteStream(file, { mode: 0o600 }), { signal: controller.signal });
      return;
    }
    throw new Error('Too many uv download redirects');
  } finally { clearTimeout(timer); cancellation.dispose(); }
}
module.exports = { createBridge, editorNetwork, download, bypass, explicitRoute };
