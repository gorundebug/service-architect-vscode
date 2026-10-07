'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseCliOutput, resolveProjectFile, navigationArgs } = require('./host');
const { ensureCli } = require('./cli-environment');
let extensionContext;

const runningActions = new Set();
let runningGenerations = 0;

async function runCli(command, args, cwd, onProgress) {
  command = await ensureCli(extensionContext, command, cwd);
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, timeout: args[0] === 'ide-generate' ? 45 * 60 * 1000 : 60000,
      maxBuffer: 24 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error?.code === 'ENOENT') {
          reject(new Error('Service Architect CLI was not found. Install sa-python-dsl or set serviceArchitect.saDslCommand to its executable path.'));
          return;
        }
        try {
          const payload = parseCliOutput(stdout, stderr);
          if (error && payload.status === 'success') reject(error);
          else resolve(payload);
        } catch (reason) { reject(reason); }
      });
    if (onProgress) {
      let pending = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'service-architect:progress' && typeof event.message === 'string') {
              onProgress(event.message.slice(0, 500));
            }
          } catch { /* Non-protocol stderr is retained by execFile for diagnostics. */ }
        }
        if (pending.length > 65536) pending = '';
      });
    }
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
    description: path.dirname(path.dirname(uri.fsPath)),
    root: path.dirname(path.dirname(uri.fsPath)),
  })), { title: 'Python project path', placeHolder: 'Select the directory containing .service-architect/project.yaml' });
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
  const configuration = vscode.workspace.getConfiguration('serviceArchitect', vscode.Uri.file(project));
  const setting = action === 'ide-generate' ? 'generatedProjectDirectory' : 'materializedDslDirectory';
  const fallback = action === 'ide-generate' ? '' : 'python-dsl';
  const output = await vscode.window.showInputBox({
    title: action === 'ide-generate' ? 'Generated project path' : 'Reviewable Python DSL destination',
    value: configuration.get(setting, fallback),
    prompt: action === 'ide-generate'
      ? `Python project path: ${project}. Leave empty for the manifest destination (workspace root for new projects), or enter an override relative to this path.`
      : 'Relative to the Python project. Existing generated files update only if unchanged.',
    validateInput: value => action === 'ide-generate' || value.trim() ? undefined : 'Choose a destination directory',
  });
  if (output === undefined) return;
  const command = configuration.get('saDslCommand', 'sa-dsl');
  const title = action === 'ide-generate' ? 'Generating and merging Service Architect project' : 'Materializing effective Python DSL';
  if (runningActions.has(project)) throw new Error('A Service Architect action is already running for this project');
  runningActions.add(project);
  const generating = action === 'ide-generate';
  if (generating) runningGenerations++;
  try {
    if (generating) await vscode.commands.executeCommand('setContext', 'serviceArchitect.generationRunning', true);
    const args = [action, '--project', project];
    if (output.trim()) args.push('--output-dir', output.trim());
    if (action === 'ide-generate') args.push('--progress-json');
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false },
      progress => {
        progress.report({ message: 'Preparing the project' });
        return runCli(command, args, project, message => progress.report({ message }));
      });
    if (result.status !== 'success') throw new Error(result.message || `${action} failed`);
    vscode.window.showInformationMessage(`Service Architect: ${title.toLowerCase()} completed in ${result.directory}`);
  } finally {
    runningActions.delete(project);
    if (generating) {
      runningGenerations--;
      await vscode.commands.executeCommand('setContext', 'serviceArchitect.generationRunning', runningGenerations > 0);
    }
  }
}

async function createProject(context, fromYaml = false) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('Trust the workspace before creating a Service Architect project.');
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Open a folder in VS Code before creating a Service Architect project.');
    return;
  }
  const root = folder.uri.fsPath;
  let sourceYaml;
  if (fromYaml) {
    const selected = await vscode.window.showOpenDialog({
      title: 'Import Service Architect YAML', openLabel: 'Import YAML',
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      filters: { YAML: ['yaml', 'yml'] }, defaultUri: folder.uri,
    });
    if (!selected?.length) return;
    sourceYaml = selected[0].fsPath;
  }
  const name = await vscode.window.showInputBox({
    title: fromYaml ? 'Import Service Architect Project from YAML' : 'Create Service Architect Project',
    value: path.basename(root),
    prompt: `Create the SA project in ${path.join(root, path.basename(root) + '-architecture')}; generated code goes into ${root}`,
    validateInput: value => value.trim() && !/[\r\n\0]/.test(value)
      ? undefined : 'Enter a non-empty project name on one line',
  });
  if (name === undefined) return;
  if (runningActions.has(root)) throw new Error('A Service Architect action is already running for this project');
  const command = vscode.workspace.getConfiguration('serviceArchitect', folder.uri).get('saDslCommand', 'sa-dsl');
  runningActions.add(root);
  let projectRoot;
  let sourceFile;
  try {
    const args = ['init', '--project', root, '--name', name.trim()];
    if (sourceYaml) args.push('--yaml', sourceYaml);
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: fromYaml ? 'Importing Service Architect project' : 'Creating Service Architect project', cancellable: false,
    }, () => runCli(command, args, root));
    if (result.status !== 'success') throw new Error(result.message || 'Cannot create project');
    projectRoot = result.directory;
    sourceFile = resolveProjectFile(projectRoot, result.source);
  } finally { runningActions.delete(root); }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourceFile));
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
  vscode.window.showInformationMessage(`Service Architect project created in ${projectRoot}`);
  await openGraph(context, vscode.Uri.file(path.join(projectRoot, '.service-architect', 'project.yaml')));
}

async function configureGeneration(resource) {
  const project = await chooseProject(resource);
  if (!project) return;
  const environment = path.join(project, '.env');
  const ignore = path.join(project, '.gitignore');
  for (const file of [environment, ignore]) {
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error(`${file} must be a regular file, not a directory or symbolic link`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let rules = '';
  try { rules = fs.readFileSync(ignore, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (rules.trimEnd().split('\n').at(-1) !== '.env') {
    fs.appendFileSync(ignore, `${rules && !rules.endsWith('\n') ? '\n' : ''}.env\n`);
  }
  try {
    fs.writeFileSync(environment,
      '# Service Architect remote code generation credentials. Do not commit this file.\n' +
      '# Set your Service Architect API key below, then run Generate and merge.\n' +
      '# Importing YAML and viewing the graph do not require a key.\n' +
      '# The API URL is configured by default; no AWS credentials are needed.\n' +
      'SERVICE_ARCHITECT_API_KEY=\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(environment));
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
}

function activate(context) {
  extensionContext = context;
  context.subscriptions.push(vscode.commands.registerCommand('serviceArchitect.configureGeneration',
    resource => configureGeneration(resource).catch(error => vscode.window.showErrorMessage(`Service Architect: ${error}`))));
  context.subscriptions.push(vscode.commands.registerCommand('serviceArchitect.importProject',
    () => createProject(context, true).catch(error => vscode.window.showErrorMessage(`Service Architect: ${error}`))));
  context.subscriptions.push(vscode.commands.registerCommand('serviceArchitect.createProject',
    () => createProject(context).catch(error => vscode.window.showErrorMessage(`Service Architect: ${error}`))));
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
