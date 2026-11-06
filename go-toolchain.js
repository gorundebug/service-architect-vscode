'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

// Resolve in the generated workspace, including a Go SDK selected via Go: Choose Go Environment.
async function goToolchainEnvironment(vscode, root, inherited = process.env) {
  const resource = vscode.Uri.file(root);
  const extension = vscode.extensions?.getExtension('golang.go');
  let executable;
  if (extension) {
    const api = extension.isActive ? extension.exports : await extension.activate();
    executable = api?.settings?.getExecutionCommand('go', resource)?.binPath;
  }
  if (!executable || executable === 'go') {
    const configuration = vscode.workspace.getConfiguration('go', resource);
    const alternate = configuration.get('alternateTools', {}).go;
    const goroot = configuration.get('goroot', '');
    executable = alternate || (goroot ? path.join(goroot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go') : executable);
  }
  if (!executable || executable === 'go') return { ...inherited };
  if (executable.startsWith('~/') || executable.startsWith('~\\')) executable = path.join(os.homedir(), executable.slice(2));
  if (!path.isAbsolute(executable)) throw new Error('The selected Go executable must be an absolute path. Select a Go SDK using Go: Choose Go Environment.');
  try { fs.accessSync(executable, fs.constants.X_OK); if (!fs.statSync(executable).isFile()) throw new Error('Not a file'); }
  catch { throw new Error(`The Go SDK selected in VS Code is unavailable: ${executable}. Select an installed SDK using Go: Choose Go Environment, then Refresh graph & calls.`); }
  const environment = { ...inherited };
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  // Let the selected Go executable resolve its own SDK instead of inheriting another SDK's root.
  delete environment.GOROOT;
  let home;
  try {
    const result = await execute(executable, ['env', 'GOROOT'], {
      env:{...environment, GOTOOLCHAIN:'local'}, cwd:os.tmpdir(), timeout:10000, maxBuffer:65536,
    });
    home = result.stdout.trim();
    if (!path.isAbsolute(home)) throw new Error('Go returned an invalid GOROOT');
    fs.accessSync(path.join(home, 'bin', process.platform === 'win32' ? 'go.exe' : 'go'), fs.constants.X_OK);
  } catch (error) { throw new Error(`Cannot resolve the selected Go SDK (${executable}): ${error.message}`); }
  // A version manager may expose go1.x or a shim: go/packages still invokes "go".
  environment[pathKey] = path.join(home, 'bin') + (environment[pathKey] ? path.delimiter + environment[pathKey] : '');
  environment.GOROOT = home;
  return environment;
}

module.exports = { goToolchainEnvironment };
