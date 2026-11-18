const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('managed CLI upgrade cannot reuse pre-direction 0.1.23 or pre-broker runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-cli-upgrade-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const create = version => {
    const directory = path.join(root, 'cli', version);
    const cli = path.join(directory, 'environment', 'bin', 'sa-dsl');
    fs.mkdirSync(path.dirname(cli), {recursive:true});
    fs.writeFileSync(cli, '#!/bin/sh\n', {mode:0o755});
    fs.writeFileSync(path.join(directory, 'ready'), version);
    return cli;
  };
  create('0.1.22');
  create('0.1.23');
  assert.notEqual(require('../package.json').serviceArchitectCliVersion, '0.1.23');
  let prompts = 0;
  const vscode = {Uri:{file:p=>p}, workspace:{isTrusted:true,getWorkspaceFolder:()=>undefined},
    window:{showInformationMessage:async()=>{prompts++; return undefined;}}};
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../cli-environment.js'),'utf8'), {
    module, process:{platform:'linux',env:{PATH:''}},
    require: name => name === 'vscode' ? vscode : name === './package.json' ? require('../package.json') :
      name.startsWith('./') ? {} : require(name)
  });
  const context = {globalStorageUri:{fsPath:root}, extensionPath:path.join(__dirname,'..')};
  await assert.rejects(module.exports.ensureCli(context,'sa-dsl',root), /CLI setup cancelled/);
  assert.equal(prompts,1);
  const current = create(require('../package.json').serviceArchitectCliVersion);
  assert.equal(await module.exports.ensureCli(context,'sa-dsl',root),current);
  assert.equal(prompts,1);
});
