const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {goToolchainEnvironment} = require('../go-toolchain');

function host(extension, settings = {}) {
  return {Uri:{file:p=>p}, extensions:{getExtension:id=>{assert.equal(id,'golang.go');return extension;}},
    workspace:{getConfiguration:(name,resource)=>{assert.equal(name,'go');assert.equal(resource,'/generated');
      return {get:(key,fallback)=>settings[key] ?? fallback};}}};
}

test('selected Go environment overrides missing PATH and stale GOROOT without changing the host', {skip:process.platform==='win32'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'sa-go-sdk-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bin = path.join(root,'SDK with spaces','bin');
  fs.mkdirSync(bin,{recursive:true});
  const go = path.join(bin,'go');
  fs.writeFileSync(go,`#!/bin/sh\nif [ "$1" = env ]; then printf '%s' '${path.dirname(bin)}'; else printf selected-sdk; fi`,{mode:0o755});
  const selected = path.join(root, 'go-selected');
  fs.copyFileSync(go, selected);
  let activated=0;
  const vscode=host({isActive:false,activate:async()=>{
    activated++;
    return {settings:{getExecutionCommand:(tool,resource)=>{
      assert.equal(tool,'go');assert.equal(resource,'/generated');return {binPath:selected};
    }}};
  }});
  const inherited={PATH:'/usr/bin:/bin',GOROOT:'/wrong-sdk',OTHER:'kept'};
  const env=await goToolchainEnvironment(vscode,'/generated',inherited);
  assert.equal(activated,1);
  assert.equal(env.GOROOT,path.dirname(bin));
  assert.equal(env.OTHER,'kept');
  assert.equal(inherited.GOROOT,'/wrong-sdk');
  assert.equal(execFileSync('go',['version'],{env,encoding:'utf8'}),'selected-sdk');
  const fallback=await goToolchainEnvironment(host(undefined,{goroot:path.dirname(bin)}),'/generated',inherited);
  assert.equal(fallback.PATH,env.PATH);
});

test('no Go extension or selection preserves PATH fallback',async()=>{
  assert.deepEqual(await goToolchainEnvironment(host(undefined),'/generated',{PATH:'/usr/bin'}),{PATH:'/usr/bin'});
});

test('unavailable selected SDK is not silently replaced with a different SDK',async()=>{
  const vscode=host({isActive:true,exports:{settings:{getExecutionCommand:()=>({binPath:'/missing-sa-sdk/bin/go'})}}});
  await assert.rejects(goToolchainEnvironment(vscode,'/generated'),/selected in VS Code is unavailable/);
});
