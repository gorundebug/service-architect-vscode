'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { findCandidates, confinedFile, basenameMatches, openImplementation, implementationFile, ownerRoots } = require('../implementation-navigation');

test('implementation navigation covers every runtime and uses current symbol ranges', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-implementation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [language, extension] of [['GoLang','go'], ['CppUserver','hpp'], ['CppCoro','cpp'], ['Python','py'], ['Rust','rs'], ['TypeScript','ts']]) {
    const file = path.join(root, 'moved.' + extension);
    fs.writeFileSync(file, '// implementation moved by the user');
    const uri = { scheme: 'file', fsPath: file };
    const range = { start: { line: 41, character: 3 } };
    const vscode = { commands: { executeCommand: async () => [{name:'Work', location:{uri,range}}] } };
    const result = await findCandidates(vscode, root, {symbols:['Work'], language, role:'function',owner:path.basename(root),service:path.basename(root)});
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
  const found = await findCandidates(vscode,root,{symbols:['WorkSource'],language:'GoLang',owner:path.basename(root),service:path.basename(root)});
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
  await openImplementation(vscode,root,{implementations:{orders:{work:[{symbols:['Work'],language:'TypeScript',owner:path.basename(root),service:path.basename(root)}]}}}, {service:'orders',key:'work'});
  assert.equal(offered,true);
  await assert.rejects(openImplementation(vscode,root,{}, {service:'orders',key:'missing'}),/no user-owned/);
});

test('all runtimes ignore archived workspace copies in symbol lookup, fallback and reverse navigation', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-owner-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [language,ext] of [['GoLang','go'],['CppUserver','cpp'],['CppCoro','hpp'],['Python','py'],['Rust','rs'],['TypeScript','ts']]) {
    const paths=['orders','other','.artifacts/snapshot/orders','docs/measurements/snapshot/orders'].map(dir=>{
      const file=path.join(root,dir,'a/b/c/Work.'+ext);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');return file;
    });
    const target={owner:'orders',service:'orders',language,symbols:['Work']};
    const locations=paths.map(fsPath=>({scheme:'file',fsPath}));
    const vscode={commands:{executeCommand:async()=>locations.map(uri=>({name:'Work',location:{uri,range:{start:{line:3,character:2}}}}))},
      RelativePattern:class {constructor(base){assert.equal(base,fs.realpathSync(path.join(root,'orders')));}},
      workspace:{findFiles:async()=>locations}};
    let found=await findCandidates(vscode,root,target);
    assert.deepEqual(found.map(item=>item.uri.fsPath),[paths[0]],language);
    assert.equal(implementationFile(root,paths[0],target),true);
    for(const file of paths.slice(1)) assert.equal(implementationFile(root,file,target),false,language+' '+file);
    vscode.commands.executeCommand=async()=>[];
    found=await findCandidates(vscode,root,target);
    assert.deepEqual(found.map(item=>item.uri.fsPath),[paths[0]],language+' fallback');
    assert.deepEqual(ownerRoots(root,{...target,owner:'missing'}),[]);
    assert.deepEqual(ownerRoots(root,{...target,owner:'../orders'}),[]);
    assert.equal(implementationFile(root,paths[0],{...target,owner:undefined}),false);
    assert.deepEqual(ownerRoots(path.join(root,'orders'),target),[fs.realpathSync(path.join(root,'orders'))]);
  }
});

test('separate language modules and shared node targets keep one actual destination',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-shared-owner-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'sa-outside-'));
  t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'shared_go'));fs.symlinkSync(outside,path.join(root,'shared_external'));
  const file=path.join(root,'shared_go','work.go');fs.writeFileSync(file,'');
  const target={owner:'shared',service:'orders',language:'GoLang',symbols:['Work']};
  assert.deepEqual(ownerRoots(root,target),[fs.realpathSync(path.join(root,'shared_go'))]);
  let opened=0;
  const vscode={Uri:{file:fsPath=>({fsPath})},ViewColumn:{One:1},
    commands:{executeCommand:async()=>[{name:'Work',location:{uri:{scheme:'file',fsPath:file},range:{start:{line:4,character:0}}}}]},
    workspace:{getConfiguration:()=>({get:()=>''}),getWorkspaceFolder:()=>({}),openTextDocument:async()=>{opened++;return {}; }},
    window:{showTextDocument:async()=>{},showQuickPick:()=>assert.fail('duplicate destination must not require a chooser')}};
  await openImplementation(vscode,root,{implementations:{orders:{work:[target,{...target}]}}},{service:'orders',key:'work'});
  assert.equal(opened,1);
});
