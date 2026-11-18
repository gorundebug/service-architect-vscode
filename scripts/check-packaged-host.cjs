'use strict';
// Run with VS Code's --extensionTestsPath against an installed/extracted VSIX.
// No mocked vscode API. Use an isolated profile and a disposable Python project.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async function () {
  const required = key => { assert.ok(process.env[key], `${key} is required`); return process.env[key]; };
  const project = path.resolve(required('SA_HOST_TEST_PROJECT'));
  const cli = path.resolve(required('SA_HOST_TEST_CLI'));
  const eventsFile = path.resolve(required('SA_HOST_TEST_CLI_EVENTS'));
  const report = path.resolve(required('SA_HOST_TEST_REPORT'));
  assert.ok(fs.existsSync(path.join(project, '.service-architect/project.yaml')), 'fixture manifest must exist');
  assert.ok(fs.existsSync(cli), 'fixture CLI must exist');
  const extension = vscode.extensions.getExtension('gorundebug.service-architect-vscode');
  assert.ok(extension, 'packaged extension must be registered');
  assert.ok(vscode.workspace.isTrusted, 'use a trusted disposable fixture');
  const previous = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').length : 0;
  await vscode.workspace.getConfiguration('serviceArchitect').update('saDslCommand', cli, vscode.ConfigurationTarget.Workspace);
  await extension.activate();
  assert.ok(extension.isActive);
  let timer;
  try {
    await Promise.race([
      vscode.commands.executeCommand('serviceArchitect.openGraph', vscode.Uri.file(path.join(project, '.service-architect/project.yaml'))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('openGraph timed out')), 30000); }),
    ]);
  } finally { clearTimeout(timer); }
  const deadline = Date.now() + 45000;
  let events = [];
  const completed = () => events.some(event => event.phase === 'completed' && event.args?.includes('ide-snapshot') && event.args?.includes(project) && event.status === 0);
  while (Date.now() < deadline) {
    if (fs.existsSync(eventsFile)) {
      // Only complete JSONL records from this invocation; ignore a partial writer tail.
      const text = fs.readFileSync(eventsFile, 'utf8').slice(previous);
      events = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
    }
    if (completed()) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(completed(), 'webview ready must trigger a successful actual CLI snapshot');
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
  assert.ok(tabs.some(tab => tab.label.startsWith('Service Architect:')), 'actual graph webview tab');
  fs.writeFileSync(report, JSON.stringify({ passed: true, extensionPath: extension.extensionPath, version: extension.packageJSON.version,
    project, tabs: tabs.map(tab => tab.label), events }, null, 2) + '\n');
};
