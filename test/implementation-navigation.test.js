'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findCandidates, confinedFile, basenameMatches, openImplementation } = require('../implementation-navigation');

test('implementation navigation covers every runtime and uses current symbol ranges', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-implementation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [language, extension] of [['GoLang','go'], ['CppUserver','hpp'], ['CppCoro','cpp'], ['Python','py'], ['Rust','rs'], ['TypeScript','ts']]) {
    const file = path.join(root, 'moved.' + extension);
    fs.writeFileSync(file, '// implementation moved by the user');
    const uri = { scheme: 'file', fsPath: file };
    const range = { start: { line: 41, character: 3 } };
    const vscode = { commands: { executeCommand: async () => [{name:'Work', location:{uri,range}}] } };
    const result = await findCandidates(vscode, root, {symbols:['Work'], language, role:'function',owner:'orders'});
    assert.equal(result.length, 1);
    assert.equal(result[0].uri.fsPath, file);
    assert.equal(result[0].range.start.line, 41);
  }
});

test('file fallback is explicit, supports nested packages and excludes escaping symlinks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-implementation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root,'a/b/c'), {recursive:true});
  const file = path.join(root,'a/b/c/work_source.go');
  fs.writeFileSync(file,'package c');
  fs.symlinkSync('/etc/passwd',path.join(root,'escape.go'));
  assert.equal(confinedFile(root,path.join(root,'escape.go'),'GoLang'),false);
  assert.equal(basenameMatches(file,['WorkSource']),true);
  let pattern;
  const vscode = { commands:{executeCommand:async()=>[]}, RelativePattern: class {constructor(root,glob){pattern=glob;}},
    workspace:{findFiles:async()=>[{scheme:'file',fsPath:file}]} };
  const found = await findCandidates(vscode,root,{symbols:['WorkSource'],language:'GoLang'});
  assert.equal(pattern,'**/*.go');
  assert.equal(found.length,1);
  assert.equal(found[0].range,undefined);
  assert.match(found[0].detail,/File match only/);
});

test('ambiguous implementations require selection; cancellation never opens a file', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-implementation-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'work.ts');fs.writeFileSync(file,'');
  const uri={scheme:'file',fsPath:file};
  let offered=false;
  const vscode={Uri:{file:fsPath=>({fsPath})},
    commands:{executeCommand:async()=>[1,2].map(line=>({name:'Work',location:{uri,range:{start:{line}}}}))},
    workspace:{getConfiguration:()=>({get:()=>''}),getWorkspaceFolder:()=>({}),openTextDocument:()=>assert.fail('must not open')},
    window:{showQuickPick:async items=>{offered=true;assert.equal(items.length,2);return undefined;}}};
  await openImplementation(vscode,root,{implementations:{orders:{work:[{symbols:['Work'],language:'TypeScript'}]}}}, {service:'orders',key:'work'});
  assert.equal(offered,true);
  await assert.rejects(openImplementation(vscode,root,{}, {service:'orders',key:'missing'}),/no user-owned/);
});
