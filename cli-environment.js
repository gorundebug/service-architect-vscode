'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const VERSION = '0.1.5';
const UV_VERSION = '0.11.22';
const windows = process.platform === 'win32';
let pendingInstallation;

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function cliIn(environment) {
  return path.join(environment, windows ? 'Scripts' : 'bin', windows ? 'sa-dsl.exe' : 'sa-dsl');
}

function findExecutable(name, common = false) {
  const directories = (process.env.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value));
  if (common) directories.push(path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  return directories.map(directory => path.join(directory, name + (windows ? '.exe' : ''))).find(executable);
}

function managedRoot(context) {
  return path.join(context.globalStorageUri.fsPath, 'cli', VERSION);
}

function resolveCli(context, command, cwd) {
  if (command !== 'sa-dsl') return command;
  const boundary = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))?.uri.fsPath;
  for (let directory = cwd; boundary &&
       (directory === boundary || directory.startsWith(boundary + path.sep)); directory = path.dirname(directory)) {
    const local = cliIn(path.join(directory, '.venv'));
    if (executable(local)) return local;
    if (path.dirname(directory) === directory) break;
  }
  const onPath = findExecutable('sa-dsl');
  if (onPath) return onPath;
  const root = managedRoot(context);
  const managed = cliIn(path.join(root, 'environment'));
  if (fs.existsSync(path.join(root, 'ready')) && executable(managed)) return managed;
  return undefined;
}

function run(command, args, root, token, extra = {}) {
  return new Promise((resolve, reject) => {
    if (token.isCancellationRequested) { reject(new Error('CLI setup cancelled')); return; }
    const env = { ...process.env, UV_CACHE_DIR: path.join(root, 'cache'),
      UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_PYTHON_DOWNLOADS: 'automatic',
      UV_NO_PROGRESS: '1', ...extra };
    for (const key of ['VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME', 'PYTHONPATH']) delete env[key];
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    let stopped;
    const capture = data => { tail = (tail + data.toString()).slice(-8192); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const stop = message => { stopped = message; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('CLI setup timed out. Check your network and retry.'), 10 * 60 * 1000);
    const cancellation = token.onCancellationRequested(() => stop('CLI setup cancelled'));
    const cleanup = () => { clearTimeout(timer); cancellation.dispose(); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (stopped) reject(new Error(stopped));
      else if (code !== 0) reject(new Error(`CLI setup failed (exit ${code}):\n${tail}`));
      else resolve();
    });
    if (token.isCancellationRequested) stop('CLI setup cancelled');
  });
}

async function install(context, progress, token) {
  const root = managedRoot(context);
  await fs.promises.mkdir(root, { recursive: true });
  const lock = path.join(root, 'setup.lock');
  try { await fs.promises.mkdir(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`CLI setup is already running in another window. If that window crashed, remove ${lock} and retry.`);
    throw error;
  }
  try {
    await fs.promises.rm(path.join(root, 'ready'), { force: true });
    let uv = findExecutable('uv', true);
    if (!uv) {
      const bin = path.join(root, 'tools');
      uv = path.join(bin, windows ? 'uv.exe' : 'uv');
      if (!executable(uv)) {
        progress.report({ message: `Downloading uv ${UV_VERSION} from Astral` });
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        const timer = setTimeout(() => controller.abort(), 45000);
        const installer = path.join(root, windows ? 'install-uv.ps1' : 'install-uv.sh');
        try {
          if (token.isCancellationRequested) throw new Error('CLI setup cancelled');
          const response = await fetch(`https://astral.sh/uv/${UV_VERSION}/${windows ? 'install.ps1' : 'install.sh'}`,
            { signal: controller.signal });
          if (!response.ok) throw new Error(`Cannot download uv installer: HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > 1024 * 1024) throw new Error('Unexpected uv installer size');
          await fs.promises.writeFile(installer, bytes);
        } finally { clearTimeout(timer); cancellation.dispose(); }
        progress.report({ message: 'Installing uv in the private plugin environment' });
        const command = windows
          ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : '/bin/sh';
        const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer] : [installer];
        await run(command, args, root, token, { UV_UNMANAGED_INSTALL: bin, UV_NO_MODIFY_PATH: '1' });
        if (!executable(uv)) throw new Error('uv installation did not produce an executable');
      }
    }
    const environment = path.join(root, 'environment');
    progress.report({ message: 'Preparing isolated Python 3.12 environment' });
    await run(uv, ['--no-config', 'venv', '--python', '3.12', '--managed-python', '--allow-existing', environment], root, token);
    progress.report({ message: 'Installing bundled Service Architect CLI and dependencies' });
    const python = path.join(environment, windows ? 'Scripts/python.exe' : 'bin/python');
    const source = path.join(context.extensionUri.fsPath, 'resources', 'sa-python-dsl');
    await run(uv, ['--no-config', 'pip', 'install', '--python', python, source], root, token);
    const cli = cliIn(environment);
    if (token.isCancellationRequested) throw new Error('CLI setup cancelled');
    if (!executable(cli)) throw new Error('Setup did not create sa-dsl');
    await fs.promises.writeFile(path.join(root, 'ready'), VERSION);
    return cli;
  } finally { await fs.promises.rmdir(lock); }
}

async function ensureCli(context, command, cwd) {
  const resolved = resolveCli(context, command, cwd);
  if (resolved) return resolved;
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before installing and running Service Architect CLI');
  if (!pendingInstallation) {
    pendingInstallation = (async () => {
      const answer = await vscode.window.showInformationMessage(
        'Service Architect CLI is not installed.', { modal: true,
          detail: 'Install the bundled CLI in a private plugin environment? This downloads Python and dependencies, and uv from Astral if needed. Your project environment and shell settings are not changed. The requested action will continue automatically after setup.' },
        'Install and continue');
      if (answer !== 'Install and continue') throw new Error('CLI setup cancelled');
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Service Architect: Installing CLI', cancellable: true },
      (progress, token) => install(context, progress, token));
    })();
  }
  const installation = pendingInstallation;
  try { return await installation; }
  finally { if (pendingInstallation === installation) pendingInstallation = undefined; }
}

module.exports = { ensureCli };
