'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { implementationFile, basenameMatches } = require('./implementation-navigation');

function inRange(range, line, column) {
  const start = [range.line, range.column || 1];
  const end = [range.endLine || range.line, range.endColumn || Number.MAX_SAFE_INTEGER];
  return (line > start[0] || line === start[0] && column >= start[1]) &&
    (line < end[0] || line === end[0] && column < end[1]);
}

function symbolNames(items, position) {
  const enclosing = new Set(), all = new Set();
  const add = (set, name) => { if (typeof name === 'string') for (const token of name.match(/[\p{L}_][\p{L}\p{N}_]*/gu) || []) set.add(token); };
  const visit = item => {
    add(all, item.name); add(all, item.containerName);
    const range = item.range || item.location?.range;
    if (range && inRange({line:range.start.line+1, column:range.start.character+1,
      endLine:range.end.line+1, endColumn:range.end.character+1}, position.line+1, position.character+1)) {
      add(enclosing,item.name); add(enclosing,item.containerName);
    }
    for (const child of item.children || []) visit(child);
  };
  for (const item of items || []) visit(item);
  return { enclosing, all };
}

function relatedNodes(snapshot, project, generatedRoot, file, text, position, symbols) {
  let real;
  try { real = fs.realpathSync(file); } catch { return { nodes: [] }; }
  const relative = path.relative(fs.realpathSync(project), real).split(path.sep).join('/');
  const source = snapshot.sourceLocations;
  if (source?.files && Object.hasOwn(source.files, relative)) {
    if (crypto.createHash('sha256').update(text).digest('hex') !== source.files[relative]) return {nodes:[],stale:true};
    const nodes = [];
    for (const [service, values] of Object.entries(source.nodes || {})) {
      for (const [key, location] of Object.entries(values)) {
        if ((location.related || [location]).some(item => item.file === relative && inRange(item,position.line+1,position.character+1)))
          nodes.push({service,key});
      }
    }
    return {nodes};
  }
  const groups = [[], [], []];
  for (const [service, values] of Object.entries(snapshot.implementations || {})) {
    for (const [key, targets] of Object.entries(values)) {
      for (const target of targets) {
        if (!implementationFile(generatedRoot,real,target)) continue;
        const node = {service,key};
        if (target.symbols.some(name => symbols.enclosing.has(name))) groups[0].push(node);
        else if (target.symbols.some(name => symbols.all.has(name))) groups[1].push(node);
        else if (basenameMatches(real,target.symbols)) groups[2].push(node);
      }
    }
  }
  const nodes = groups.find(group => group.length) || [];
  return {nodes:[...new Map(nodes.map(node => [JSON.stringify(node),node])).values()]};
}

// Unlike cursor fallback, a clickable marker requires an exact expression or
// a declaration returned by the language provider. Never mark guessed file lines.
function lineMarkers(snapshot, project, generatedRoot, file, text, symbols) {
  let real, relative;
  try { real=fs.realpathSync(file); relative=path.relative(fs.realpathSync(project),real).split(path.sep).join('/'); }
  catch { return []; }
  const lines=new Map();
  const add=(line,column,node)=>{
    const value=lines.get(line)||{line,column,nodes:new Map()};
    value.column=Math.min(value.column,column); value.nodes.set(JSON.stringify(node),node); lines.set(line,value);
  };
  const source=snapshot.sourceLocations;
  if(source?.files && Object.hasOwn(source.files,relative)) {
    if(crypto.createHash('sha256').update(text).digest('hex')!==source.files[relative]) return [];
    for(const [service,nodes] of Object.entries(source.nodes||{})) for(const [key,location] of Object.entries(nodes))
      for(const range of location.related||[location]) if(range.file===relative) add(range.line-1,(range.column||1)-1,{service,key});
  } else {
    const visit=item=>{
      const start=(item.selectionRange||item.range||item.location?.range)?.start;
      if(start) for(const [service,nodes] of Object.entries(snapshot.implementations||{})) for(const [key,targets] of Object.entries(nodes))
        if(targets.some(target=>implementationFile(generatedRoot,real,target) && target.symbols.some(name=>
          item.name===name || item.name?.startsWith(name+'(') || item.name?.startsWith(name+'<') || item.name?.endsWith('::'+name)))) add(start.line,start.character,{service,key});
      for(const child of item.children||[]) visit(child);
    };
    for(const item of symbols||[]) visit(item);
  }
  return [...lines.values()].sort((a,b)=>a.line-b.line).map(item=>({...item,nodes:[...item.nodes.values()]}));
}

function attachReverseNavigation(vscode, project, panel, getSnapshot) {
  let alive = true, request = 0, timer, lastEditor = vscode.window.activeTextEditor;
  let symbolCache;
  const id=crypto.randomUUID();
  const markerCache=new Map();
  const markerChanges=new vscode.EventEmitter();
  const markerProvider=vscode.languages.registerCodeLensProvider({scheme:'file'}, {
    onDidChangeCodeLenses:markerChanges.event,
    async provideCodeLenses(document,token) {
      const snapshot=getSnapshot(),version=document.version;
      if(!alive||!snapshot) return [];
      const directory=vscode.workspace.getConfiguration('serviceArchitect').get('generatedProjectDirectory','')||snapshot.generationOutputDirectory||'.';
      const root=path.resolve(project,directory);
      let isSource=false;
      try { isSource=Object.hasOwn(snapshot.sourceLocations?.files||{},path.relative(fs.realpathSync(project),fs.realpathSync(document.uri.fsPath)).split(path.sep).join('/')); }
      catch { return []; }
      if(!isSource && !Object.values(snapshot.implementations||{}).some(nodes=>Object.values(nodes).some(targets=>
        targets.some(target=>implementationFile(root,document.uri.fsPath,target))))) return [];
      let items=[];
      try { if(!isSource) items=await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',document.uri)||[]; }
      catch { /* DSL expressions do not need a language provider. */ }
      if(!alive||token.isCancellationRequested||getSnapshot()!==snapshot||document.version!==version) return [];
      const markers=lineMarkers(snapshot,project,root,document.uri.fsPath,document.getText(),items);
      markerCache.set(document.uri.fsPath,{snapshot,version,markers});
      return markers.map(marker=>
        new vscode.CodeLens(new vscode.Range(marker.line,marker.column,marker.line,marker.column), {
          title:`Show in Graph${marker.nodes.length>1 ? ` (${marker.nodes.length} nodes)` : ''}`,
          command:'serviceArchitect.showGraphMarker',arguments:[id,document.uri,{line:marker.line,character:marker.column},snapshot.revision,version],
          tooltip:marker.nodes.map(node=>`${node.service} / ${node.key}`).join('\n'),
        }));
    },
  });
  const changed=vscode.workspace.onDidChangeTextDocument(event=>{markerCache.delete(event.document.uri.fsPath);markerChanges.fire();});
  const closed=vscode.workspace.onDidCloseTextDocument(document=>markerCache.delete(document.uri.fsPath));
  const configured=vscode.workspace.onDidChangeConfiguration(event=>{
    if(event.affectsConfiguration('serviceArchitect.generatedProjectDirectory')) {markerCache.clear();markerChanges.fire();}
  });
  async function update(focus = false, target, markerNodes) {
    const epoch = ++request;
    const editor = target || vscode.window.activeTextEditor || lastEditor;
    const snapshot = getSnapshot();
    if (!alive || !editor || !snapshot || editor.document.uri.scheme !== 'file') return;
    if (!target) lastEditor = editor;
    const version = editor.document.version;
    const file = editor.document.uri.fsPath;
    const position = editor.selection.active;
    const directory = vscode.workspace.getConfiguration('serviceArchitect').get('generatedProjectDirectory','') || snapshot.generationOutputDirectory || '.';
    let items = [];
    try {
      if (markerNodes) items=[];
      else if (symbolCache?.file === file && symbolCache.version === version) items = symbolCache.items;
      else {
        items = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',editor.document.uri) || [];
        symbolCache = {file,version,items};
      }
    } catch { /* Source provenance and file matches also work without a language provider. */ }
    if (!alive || epoch !== request || getSnapshot() !== snapshot || editor.document.version !== version) return;
    const result = markerNodes ? {nodes:markerNodes} : relatedNodes(snapshot,project,path.resolve(project,directory),file,editor.document.getText(),position,symbolNames(items,position));
    let chosen;
    if (focus) {
      if (!result.nodes.length) {
        vscode.window.showInformationMessage(result.stale ? 'Refresh the graph after saving Python DSL changes.' : 'No graph node is associated with this code. Refresh the graph and check the generated project directory.');
        return;
      }
      chosen = result.nodes.length === 1 ? result.nodes[0] : await vscode.window.showQuickPick(
        result.nodes.map(node => ({label:node.key,description:node.service,...node})), {title:'Show in Graph — select a node'});
      if (!chosen || !alive || epoch !== request || getSnapshot() !== snapshot) return;
      panel.reveal(vscode.ViewColumn.Beside, true);
    }
    panel.webview.postMessage({type:'service-architect:editor-selection',revision:snapshot.revision,nodes:result.nodes,
      ...(chosen ? {focus:{service:chosen.service,key:chosen.key}} : {})});
  }
  const schedule = editor => {
    if (editor) lastEditor=editor;
    clearTimeout(timer); ++request;
    timer=setTimeout(()=>{ void update().catch(()=>{}); },180);
  };
  const selection = vscode.window.onDidChangeTextEditorSelection(event=>schedule(event.textEditor));
  const active = vscode.window.onDidChangeActiveTextEditor(editor=>{if(editor)schedule(editor);});
  return {id,project, refresh:()=>{markerCache.clear();markerChanges.fire();schedule();}, show:()=>{clearTimeout(timer);return update(true);},
    async showAt(uri,position,revision,version) {
      if(!alive||getSnapshot()?.revision!==revision) return;
      const document=await vscode.workspace.openTextDocument(uri);
      const cached=markerCache.get(uri.fsPath);
      if(document.version!==version||cached?.snapshot!==getSnapshot()||cached.version!==version) return;
      const marker=cached.markers.find(item=>item.line===position.line && item.column===position.character);
      if(marker) {clearTimeout(timer);await update(true,{document,selection:{active:position}},marker.nodes);}
    },
    dispose(){alive=false;++request;clearTimeout(timer);markerCache.clear();selection.dispose();active.dispose();changed.dispose();closed.dispose();configured.dispose();markerProvider.dispose();markerChanges.dispose();}};
}

module.exports={attachReverseNavigation,relatedNodes,symbolNames,inRange,lineMarkers};
