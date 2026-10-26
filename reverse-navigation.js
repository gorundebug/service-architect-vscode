'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { confinedFile, basenameMatches } = require('./implementation-navigation');

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
        if (!confinedFile(generatedRoot,real,target.language)) continue;
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

function attachReverseNavigation(vscode, project, panel, getSnapshot) {
  let alive = true, request = 0, timer, lastEditor = vscode.window.activeTextEditor;
  let symbolCache;
  async function update(focus = false) {
    const epoch = ++request;
    const editor = vscode.window.activeTextEditor || lastEditor;
    const snapshot = getSnapshot();
    if (!alive || !editor || !snapshot || editor.document.uri.scheme !== 'file') return;
    lastEditor = editor;
    const version = editor.document.version;
    const file = editor.document.uri.fsPath;
    const position = editor.selection.active;
    const directory = vscode.workspace.getConfiguration('serviceArchitect').get('generatedProjectDirectory','') || snapshot.generationOutputDirectory || '.';
    let items = [];
    try {
      if (symbolCache?.file === file && symbolCache.version === version) items = symbolCache.items;
      else {
        items = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider',editor.document.uri) || [];
        symbolCache = {file,version,items};
      }
    } catch { /* Source provenance and file matches also work without a language provider. */ }
    if (!alive || epoch !== request || getSnapshot() !== snapshot || editor.document.version !== version) return;
    const result = relatedNodes(snapshot,project,path.resolve(project,directory),file,editor.document.getText(),position,symbolNames(items,position));
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
  return {project, refresh:()=>schedule(), show:()=>update(true),
    dispose(){alive=false;++request;clearTimeout(timer);selection.dispose();active.dispose();}};
}

module.exports={attachReverseNavigation,relatedNodes,symbolNames,inRange};
