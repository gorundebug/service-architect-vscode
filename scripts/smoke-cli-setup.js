'use strict';
// Opt-in network smoke test in a fresh container: no preinstalled uv/Python/CLI.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-cli-smoke-'));
  const secrets = new Map();
  const context = { globalStorageUri: { fsPath: path.join(root, 'private') }, extensionUri: { fsPath: path.resolve('.') },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value) } };
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const vscode = {
    workspace: { isTrusted: true, getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      getConfiguration: () => ({ get: (_, fallback) => fallback }) },
    Uri: { file: fsPath => ({ fsPath }) }, ProgressLocation: { Notification: 1 },
    window: { showInformationMessage: async () => 'Install and continue',
      withProgress: async (_, action) => action({ report: ({ message }) => console.log(message) }, token),
      showInputBox: async () => { throw new Error('Unexpected interactive proxy authentication'); } },
  };
  const original = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? vscode : original.call(this, id, ...args); };
  try {
    const { ensureCli } = require('../cli-environment');
    const executable = await ensureCli(context, 'sa-dsl', root);
    console.log(execFileSync(executable, ['--help'], { encoding: 'utf8', timeout: 30000 }).slice(0, 500));
    if (await ensureCli(context, 'sa-dsl', root) !== executable) throw new Error('Installed CLI was not reused');
    console.log('Fresh CLI installation and reuse: PASS');
  } finally { Module._load = original; await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
