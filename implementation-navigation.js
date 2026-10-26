'use strict';
const fs = require('node:fs');
const path = require('node:path');

const extensions = {
  GoLang: ['go'], CppUserver: ['cpp', 'cc', 'cxx', 'hpp', 'h', 'hxx'],
  CppCoro: ['cpp', 'cc', 'cxx', 'hpp', 'h', 'hxx'],
  Python: ['py'], Rust: ['rs'], TypeScript: ['ts', 'tsx'],
};
const excluded = '**/{.git,node_modules,.venv,venv,target,build,dist,vendor,.dependencies}/**';

function confinedFile(root, file, language) {
  if (!extensions[language]?.includes(path.extname(file).slice(1))) return false;
  try {
    const real = fs.realpathSync(file);
    const relative = path.relative(fs.realpathSync(root), real);
    if (relative.split(path.sep).some(part => ['.git', 'node_modules', '.venv', 'venv', 'target', 'build', 'dist', 'vendor', '.dependencies'].includes(part))) return false;
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  } catch { return false; }
}

function basenameMatches(file, symbols) {
  const stem = path.basename(file, path.extname(file));
  const normalized = value => value.replace(/[-_]/g, '').toLowerCase();
  return symbols.some(symbol => normalized(stem) === normalized(symbol));
}

async function findCandidates(vscode, root, target) {
  const candidates = new Map();
  const symbols = target.symbols.filter(name => typeof name === 'string' && name.length < 256);
  for (const name of symbols) {
    const matches = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', name) || [];
    for (const item of matches) {
      const location = item.location;
      if (!symbols.includes(item.name) || location?.uri?.scheme !== 'file' || !location.range ||
          !confinedFile(root, location.uri.fsPath, target.language)) continue;
      const key = location.uri.fsPath + ':' + location.range.start.line;
      candidates.set(key, { label: item.name, description: path.relative(root, location.uri.fsPath),
        detail: `${target.role} · ${target.owner} · ${target.package || '(root package)'}`,
        uri: location.uri, range: location.range });
    }
  }
  if (candidates.size) return [...candidates.values()];
  // A language extension may be absent, or may not implement workspace symbols.
  // Offer matching files explicitly, never pretend line 1 is a resolved symbol.
  const suffixes = extensions[target.language];
  if (!suffixes) return [];
  const pattern = suffixes.length === 1 ? `**/*.${suffixes[0]}` : `**/*.{${suffixes.join(',')}}`;
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), excluded, 10000);
  for (const uri of files) {
    if (!confinedFile(root, uri.fsPath, target.language) || !basenameMatches(uri.fsPath, symbols)) continue;
    candidates.set(uri.fsPath, { label: path.basename(uri.fsPath), description: path.relative(root, uri.fsPath),
      detail: 'File match only — install/enable language support for symbol navigation', uri });
  }
  return [...candidates.values()];
}

async function openImplementation(vscode, project, snapshot, selection) {
  const targets = snapshot.implementations?.[selection.service]?.[selection.key];
  if (!Array.isArray(targets) || !targets.length) throw new Error('This node has no user-owned implementation');
  const config = vscode.workspace.getConfiguration('serviceArchitect');
  const directory = config.get('generatedProjectDirectory', '') || snapshot.generationOutputDirectory || '.';
  const destination = path.resolve(project, directory);
  if (!fs.existsSync(destination)) throw new Error(`Generated project directory does not exist: ${destination}`);
  const root = fs.realpathSync(destination);
  const inWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) ||
    vscode.workspace.workspaceFolders?.some(folder => {
      const relative = path.relative(fs.realpathSync(folder.uri.fsPath), root);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
  if (!inWorkspace) {
    throw new Error('Open the generated project directory in this workspace before navigating to implementations');
  }
  const candidates = [];
  for (const target of targets) candidates.push(...await findCandidates(vscode, root, target));
  if (!candidates.length) throw new Error(`Implementation not found under ${root}. Check the generated project directory and language extension, and wait for indexing.`);
  const selected = candidates.length === 1 ? candidates[0] : await vscode.window.showQuickPick(candidates,
    { title: 'Select business implementation', matchOnDescription: true, matchOnDetail: true });
  if (!selected) return;
  const document = await vscode.workspace.openTextDocument(selected.uri);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One,
    ...(selected.range ? { selection: selected.range } : {}) });
}

module.exports = { openImplementation, findCandidates, basenameMatches, confinedFile };
