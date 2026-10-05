'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseCliOutput, resolveProjectFile, navigationArgs } = require('./host');

function runCli(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: args[0] === 'ide-generate' ? 0 : 60000,
      maxBuffer: 24 * 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          const payload = parseCliOutput(stdout, stderr);
          if (error && payload.status === 'success') reject(error);
          else resolve(payload);
        } catch (reason) { reject(reason); }
      });
  });
}

async function chooseProject(resource) {
  const isMaterialized = root => fs.existsSync(path.join(root, '.service-architect', 'materialized.json'));
  if (resource?.fsPath && path.basename(resource.fsPath) === 'project.yaml' &&
      path.basename(path.dirname(resource.fsPath)) === '.service-architect') {
    const root = path.dirname(path.dirname(resource.fsPath));
    if (isMaterialized(root)) throw new Error('Select the authoring Python project, not its materialized snapshot');
    return root;
  }
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activePath));
    const boundary = folder?.uri.fsPath;
    let current = path.dirname(activePath);
    while (boundary && (current === boundary || current.startsWith(boundary + path.sep))) {
      if (!isMaterialized(current) && fs.existsSync(path.join(current, '.service-architect', 'project.yaml'))) return current;
      current = path.dirname(current);
    }
  }
  const discovered = await vscode.workspace.findFiles('**/.service-architect/project.yaml',
    '**/{node_modules,.venv,build,dist}/**');
  const manifests = discovered.filter(uri => !isMaterialized(path.dirname(path.dirname(uri.fsPath))));
  if (!manifests.length) throw new Error('No .service-architect/project.yaml found in this workspace');
  if (manifests.length === 1) return path.dirname(path.dirname(manifests[0].fsPath));
  const choice = await vscode.window.showQuickPick(manifests.map(uri => ({
    label: vscode.workspace.asRelativePath(uri),
    root: path.dirname(path.dirname(uri.fsPath)),
  })), { placeHolder: 'Select a Python Service Architect project' });
  return choice?.root;
}

function webviewHtml(panel, extensionUri) {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'designer.css'));
  const host = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'host-vscode.js'));
  const graph = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'designer.js'));
  return `<!doctype html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${panel.webview.cspSource}; script-src ${panel.webview.cspSource}; worker-src blob:; img-src data: ${panel.webview.cspSource}; font-src data: ${panel.webview.cspSource};">
    <link rel="stylesheet" href="${css}"></head><body><div id="service-architect-designer" data-snapshot-host="ide"></div>
    <script src="${host}"></script><script src="${graph}"></script></body></html>`;
}

async function openGraph(context, resource) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust the workspace before executing its Service Architect Python project.');
    return;
  }
  const project = await chooseProject(resource);
  if (!project) return;
  const command = vscode.workspace.getConfiguration('serviceArchitect').get('saDslCommand', 'sa-dsl');
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('serviceArchitectGraph',
    `Service Architect: ${path.basename(project)}`, vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [media] });
  let alive = true;
  let generation = 0;
  let revision = '';
  let debounce;
  const refresh = async () => {
    const current = ++generation;
    try {
      const result = await runCli(command, ['ide-snapshot', '--project', project], project);
      if (result.status !== 'success' || !result.snapshot) throw new Error(result.message || 'Cannot export Python graph');
      if (alive && current === generation) {
        revision = result.snapshot.revision;
        panel.webview.postMessage({ type: 'service-architect:snapshot', snapshot: result.snapshot });
      }
    } catch (error) {
      if (alive && current === generation) vscode.window.showErrorMessage(`Service Architect: ${error}`);
    }
  };
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(refresh, 350); };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project, '**/*.py'));
  watcher.onDidChange(schedule); watcher.onDidCreate(schedule); watcher.onDidDelete(schedule);
  const manifestWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(project, '.service-architect/project.yaml'));
  manifestWatcher.onDidChange(schedule);
  panel.webview.onDidReceiveMessage(async message => {
    if (!alive) return;
    if (message?.type === 'ready') { refresh(); return; }
    if (message?.type !== 'navigate') return;
    if (message.selection?.revision !== revision) return;
    try {
      const location = await runCli(command, navigationArgs(project, message.selection), project);
      if (location.status !== 'success') throw new Error(location.message || 'Source location not found');
      const file = resolveProjectFile(project, location.location.file);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      const position = new vscode.Position(location.location.line - 1, location.location.column - 1);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (error) { vscode.window.showWarningMessage(`Service Architect: ${error}`); }
  });
  panel.onDidDispose(() => {
    alive = false; clearTimeout(debounce); watcher.dispose(); manifestWatcher.dispose();
  });
  panel.webview.html = webviewHtml(panel, context.extensionUri);
}

async function runProjectAction(resource, action) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust the workspace before executing its Service Architect Python project.');
    return;
  }
  const project = await chooseProject(resource);
  if (!project) return;
  const configuration = vscode.workspace.getConfiguration('serviceArchitect');
  const setting = action === 'ide-generate' ? 'generatedProjectDirectory' : 'materializedDslDirectory';
  const fallback = action === 'ide-generate' ? 'dist/generated-project' : 'python-dsl';
  const output = await vscode.window.showInputBox({
    title: action === 'ide-generate' ? 'Generated project destination' : 'Reviewable Python DSL destination',
    value: configuration.get(setting, fallback),
    prompt: action === 'ide-generate'
      ? 'Relative to the Python project, or an absolute path. Existing files are handled by ServiceGen merge.'
      : 'Relative to the Python project. Existing generated files update only if unchanged.',
    validateInput: value => value.trim() ? undefined : 'Choose a destination directory',
  });
  if (output === undefined) return;
  const command = configuration.get('saDslCommand', 'sa-dsl');
  const title = action === 'ide-generate' ? 'Generating and merging Service Architect project' : 'Materializing effective Python DSL';
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title },
    () => runCli(command, [action, '--project', project, '--output-dir', output], project));
  if (result.status !== 'success') throw new Error(result.message || `${action} failed`);
  vscode.window.showInformationMessage(`Service Architect: ${title.toLowerCase()} completed in ${result.directory}`);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('serviceArchitect.openGraph',
    resource => openGraph(context, resource).catch(error => vscode.window.showErrorMessage(`Service Architect: ${error}`))));
  for (const [command, action] of [
    ['serviceArchitect.materializeDsl', 'ide-materialize'],
    ['serviceArchitect.generateProject', 'ide-generate'],
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, resource =>
      runProjectAction(resource, action).catch(error =>
        vscode.window.showErrorMessage(`Service Architect: ${error}`))));
  }
}
function deactivate() {}
module.exports = { activate, deactivate };
