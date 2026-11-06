const test=require('node:test');
const assert=require('node:assert/strict');
const {attachSubstreamCalls}=require('../substream-calls');

test('only Refresh invalidates analysis; no code or configuration listeners are installed',async()=>{
 const messages=[];let resolve;
 const snapshot={revision:'r1',generationOutputDirectory:'..'};
 const vscode={Uri:{file:p=>p},workspace:{isTrusted:true,textDocuments:[],workspaceFolders:[],
  getConfiguration:()=>({get:()=>''}),getWorkspaceFolder:()=>({}),
  onDidChangeTextDocument:()=>assert.fail("Unexpected document listener"),
  onDidChangeConfiguration:()=>assert.fail("Unexpected configuration listener"),
  createFileSystemWatcher:()=>assert.fail("Unexpected file watcher")}};
 const panel={webview:{postMessage:value=>messages.push(value)}};
 const cli=()=>new Promise(r=>{resolve=r});
 const view=attachSubstreamCalls(vscode,'/project/model',panel,()=>snapshot,cli,'sa-dsl');
 const selection={revision:'r1',service:'orders'};
 const first=view.run(selection);view.invalidate();resolve({status:'success',revision:'r1',links:[]});await first;
 assert.deepEqual(messages.map(m=>m.status),['running','cleared']);
 const second=view.run(selection);resolve({status:'success',revision:'r1',links:[{source:'a',target:'b'}]});await second;
 assert.equal(messages.at(-1).links.length,1);
 const third=view.run(selection);view.dispose();resolve({status:'success'});await third;
 assert.equal(messages.at(-1).status,'running');
});

test('unsaved files are not silently analyzed from older disk contents',async()=>{
 let executed=false;
 const disposable={dispose(){}};
 const vscode={Uri:{file:p=>p},workspace:{isTrusted:true,workspaceFolders:[],textDocuments:[{isDirty:true,uri:{scheme:'file'}}],
  getConfiguration:()=>({get:()=>''}),getWorkspaceFolder:()=>({}),onDidChangeTextDocument:()=>disposable,onDidChangeConfiguration:()=>disposable}};
 const view=attachSubstreamCalls(vscode,'/project',{webview:{postMessage(){}}},()=>({revision:'r'}),()=>{executed=true},'sa-dsl');
 await assert.rejects(view.run({revision:'r',service:'orders'}),/Save source changes/);
 assert.equal(executed,false);view.dispose();
});

test('refresh analyzes all services without a selected node',async()=>{
 const messages=[];let args;
 const disposable={dispose(){}};
 const vscode={Uri:{file:p=>p},workspace:{isTrusted:true,workspaceFolders:[],textDocuments:[],
  getConfiguration:()=>({get:()=>''}),getWorkspaceFolder:()=>({}),onDidChangeTextDocument:()=>disposable,onDidChangeConfiguration:()=>disposable}};
 const view=attachSubstreamCalls(vscode,'/project',{webview:{postMessage:m=>messages.push(m)}},()=>snapshot,
  async(_,values)=>{args=values;return {status:'success',revision:'r',links:[]};},'sa-dsl');
 const snapshot={revision:'r'};
 await view.run({revision:'r'});
 assert.equal(args.includes('--service'),false);
 assert.deepEqual(messages.map(m=>m.status),['running','success']);view.dispose();
});
