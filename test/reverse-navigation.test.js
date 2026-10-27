'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { relatedNodes, symbolNames, inRange } = require('../reverse-navigation');

test('ranges are UTF-16 positions with exclusive end and support multiline calls', () => {
  const range={line:2,column:3,endLine:4,endColumn:9};
  assert.equal(inRange(range,2,2),false);
  assert.equal(inRange(range,3,1),true);
  assert.equal(inRange(range,4,8),true);
  assert.equal(inRange(range,4,9),false);
});

test('DSL factory locations return all instances, distinguish callers and reject unsaved edits', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-reverse-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'model.py'), text='factory source';
  fs.writeFileSync(file,text);
  const body={file:'model.py',line:4,column:1,endLine:6,endColumn:10};
  const snapshot={sourceLocations:{files:{'model.py':crypto.createHash('sha256').update(text).digest('hex')},nodes:{svc:{
    one:{...body,related:[body,{file:'model.py',line:8,column:1,endColumn:20}]},
    two:{...body,related:[body,{file:'model.py',line:9,column:1,endColumn:20}]},
  }}}};
  const find=(line,content=text)=>relatedNodes(snapshot,root,root,file,content,{line,character:2},{enclosing:new Set(),all:new Set()});
  assert.deepEqual(find(4).nodes,[{service:'svc',key:'one'},{service:'svc',key:'two'}]);
  assert.deepEqual(find(7).nodes,[{service:'svc',key:'one'}]);
  assert.deepEqual(find(4,'edited'),{nodes:[],stale:true});
});

test('business code matches current language symbols for every runtime and preserves shared nodes', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-reverse-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [language,ext] of [['GoLang','go'],['CppUserver','cpp'],['CppCoro','hpp'],['Rust','rs'],['Python','py'],['TypeScript','ts']]) {
    const file=path.join(root,`business.${ext}`);fs.writeFileSync(file,'');
    const target={language,symbols:['ProcessOrder'],owner:path.basename(root),service:path.basename(root)};
    const snapshot={implementations:{svc:{one:[target],two:[target],other:[{...target,symbols:['Other']}]}}};
    const symbols=symbolNames([{name:'ProcessOrder',range:{start:{line:0,character:0},end:{line:20,character:0}}},
      {name:'Other',range:{start:{line:21,character:0},end:{line:30,character:0}}}],{line:4,character:0});
    assert.deepEqual(relatedNodes(snapshot,root,root,file,'',{line:4,character:0},symbols).nodes,
      [{service:'svc',key:'one'},{service:'svc',key:'two'}],language);
    assert.deepEqual(relatedNodes(snapshot,root,path.join(root,'elsewhere'),file,'',{line:4,character:0},symbols).nodes,[]);
  }
});
