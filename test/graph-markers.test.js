'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {lineMarkers,attachReverseNavigation}=require('../reverse-navigation');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sa-markers-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'model.py'),text='one=factory(); two=factory()\n';fs.writeFileSync(file,text);
  const range={file:'model.py',line:1,column:5,endLine:1,endColumn:14};
  const snapshot={revision:'one',generationOutputDirectory:'.',sourceLocations:{files:{'model.py':crypto.createHash('sha256').update(text).digest('hex')},nodes:{svc:{
    one:{...range,related:[range]},two:{...range,related:[{...range,column:20,endColumn:29}]},
  }}}};
  return {root,file,text,snapshot};
}
test('DSL line markers group shared/same-line nodes and reject stale text',t=>{
  const {root,file,text,snapshot}=fixture(t);
  assert.deepEqual(lineMarkers(snapshot,root,root,file,text,[]),[{line:0,column:4,nodes:[{service:'svc',key:'one'},{service:'svc',key:'two'}]}]);
  assert.deepEqual(lineMarkers(snapshot,root,root,file,text+'# edit',[]),[]);
});
test('business markers cover every runtime, only exact declarations, never file-only fallback',t=>{
  const {root}=fixture(t);
  for(const [language,ext] of [['GoLang','go'],['CppUserver','cpp'],['CppCoro','hpp'],['Rust','rs'],['Python','py'],['TypeScript','ts']]) {
    const file=path.join(root,'Process.'+ext);fs.writeFileSync(file,'');
    const target={language,symbols:['Process']},snapshot={implementations:{svc:{one:[target],two:[target]}}};
    const symbol={name:'Process',range:{start:{line:2,character:0},end:{line:9,character:0}},selectionRange:{start:{line:2,character:6},end:{line:2,character:13}}};
    assert.deepEqual(lineMarkers(snapshot,root,root,file,'',[symbol]),[{line:2,column:6,nodes:[{service:'svc',key:'one'},{service:'svc',key:'two'}]}],language);
    assert.deepEqual(lineMarkers(snapshot,root,root,file,'',[]),[],language+' no guessed line');
    assert.deepEqual(lineMarkers(snapshot,root,root,file,'',[{...symbol,name:'Unrelated'}]),[]);
  }
});
test('CodeLens focuses its node rather than the current caret, and stale/disposed commands do nothing',async t=>{
  const {root,file,text,snapshot}=fixture(t);
  const uri={scheme:'file',fsPath:file},document={uri,version:1,getText:()=>text};
  const messages=[];let provider;let chosen;
  const disposable={dispose(){}};
  const vscode={
    EventEmitter:class {event=()=>disposable;fire(){}dispose(){}},
    Range:class {constructor(...args){this.args=args;}},
    CodeLens:class {constructor(range,command){this.range=range;this.command=command;}},
    languages:{registerCodeLensProvider(_selector,value){provider=value;return disposable;}},
    workspace:{getConfiguration:()=>({get:()=>''}),onDidChangeTextDocument:()=>disposable,onDidCloseTextDocument:()=>disposable,onDidChangeConfiguration:()=>disposable,openTextDocument:async()=>document},
    window:{activeTextEditor:{document,selection:{active:{line:20,character:0}}},onDidChangeTextEditorSelection:()=>disposable,onDidChangeActiveTextEditor:()=>disposable,
      showQuickPick:async nodes=>{chosen=nodes;return nodes[0];},showInformationMessage:()=>{}},
    commands:{executeCommand:async()=>[]},ViewColumn:{Beside:2},
  };
  const view=attachReverseNavigation(vscode,root,{reveal(){},webview:{postMessage:value=>messages.push(value)}},()=>snapshot);
  const lenses=await provider.provideCodeLenses(document,{isCancellationRequested:false});
  assert.equal(lenses.length,1);
  assert.match(lenses[0].command.title,/2 nodes/);
  await view.showAt(uri,{line:0,character:4},snapshot.revision,1);
  // Both same-line nodes are represented by this marker; focus must retain that set.
  assert.equal(messages[0].focus.key,'one');
  assert.equal(chosen.length,2);
  assert.equal(messages[0].nodes.length,2);
  document.version=2;
  await view.showAt(uri,{line:0,character:4},snapshot.revision,1);
  assert.equal(messages.length,1);
  view.dispose();
  assert.deepEqual(await provider.provideCodeLenses(document,{isCancellationRequested:false}),[]);
});
