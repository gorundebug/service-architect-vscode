'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const { parseCliOutput, resolveProjectFile, navigationArgs } = require('../host');

test('CLI JSON and confined Python path', t => {
  assert.deepEqual(parseCliOutput('{"status":"success"}', ''), { status: 'success' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-architect-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'services'));
  fs.writeFileSync(path.join(root, 'services/order.py'), 'pass\n');
  fs.symlinkSync('/etc/passwd', path.join(root, 'services/escape.py'));
  assert.equal(resolveProjectFile(root, 'services/order.py'), fs.realpathSync(path.join(root, 'services/order.py')));
  assert.throws(() => resolveProjectFile(root, '../outside.py'));
  assert.throws(() => resolveProjectFile(root, 'graph.yaml'));
  assert.throws(() => resolveProjectFile(root, 'services/escape.py'));
});

test('navigation uses existing keys, not a source map', () => {
  assert.deepEqual(navigationArgs('/project', { kind: 'node', service: 'orders', key: 'validateOrder' }),
    ['ide-locate', '--project', '/project', '--kind', 'node', '--service', 'orders', '--key', 'validateOrder']);
  assert.deepEqual(navigationArgs('/project', { kind: 'link', service: 'orders',
    key: 'a_b', source: 'a', target: 'b' }).slice(-4),
    ['--source', 'a', '--target', 'b']);
});

test('embedded Designer selection uses the shared IDE event contract', () => {
  const listeners = new Map();
  const messages = [];
  const window = { addEventListener: (type, callback) => listeners.set(type, callback) };
  const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'host-vscode.js'), 'utf8');
  vm.runInNewContext(script, {
    window, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) }),
  });
  listeners.get('load')();
  listeners.get('service-architect:selection')({ detail: {
    revision: 'sha256:one', kind: 'node', service: 'orders', key: 'processOrder',
  } });
  assert.equal(messages[0].type, 'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(messages[1])), { type: 'navigate', selection: {
    revision: 'sha256:one', kind: 'node', service: 'orders', key: 'processOrder',
  } });
});

test('editor selections use a separate incoming channel and never navigate to source', () => {
  const listeners=new Map(), events=[], messages=[];
  const window={addEventListener:(type,callback)=>listeners.set(type,callback),dispatchEvent:event=>events.push(event)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','media','host-vscode.js'),'utf8'), {
    window,CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    acquireVsCodeApi:()=>({postMessage:message=>messages.push(message)}),
  });
  const data={type:'service-architect:editor-selection',revision:'one',nodes:[{service:'svc',key:'node'}]};
  listeners.get('message')({data});
  assert.equal(events[0].type,'service-architect:editor-selection');
  assert.equal(events[0].detail,data);
  assert.deepEqual(messages,[]);
});
