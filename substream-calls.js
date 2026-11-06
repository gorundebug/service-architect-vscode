'use strict';
const path = require('node:path');

// Analysis is requested only by Refresh. No code/configuration watchers are registered.
function attachSubstreamCalls(vscode, project, panel, getSnapshot, runCli, command) {
  let epoch = 0, alive = true;
  const directory = () => vscode.workspace.getConfiguration('serviceArchitect').get('generatedProjectDirectory', '') || getSnapshot()?.generationOutputDirectory || '.';
  const send = result => panel.webview.postMessage({type:'service-architect:code-calls', ...result});
  const invalidate = () => {
    ++epoch;
    if (alive) send({revision:getSnapshot()?.revision,status:'cleared'});
  };
  return {
    invalidate,
    async run(selection) {
      const snapshot = getSnapshot();
      if (!alive || !vscode.workspace.isTrusted || !snapshot || selection.revision !== snapshot.revision) return;
      const current = ++epoch;
      const output = directory();
      const root = path.resolve(project, output);
      if (!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))) {
        throw new Error('Open the generated project directory in this workspace before analyzing calls');
      }
      if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'file')) {
        throw new Error('Save source changes before analyzing SubStream calls');
      }
      send({revision:snapshot.revision,status:'running'});
      try {
        const result = await runCli(command, ['ide-substream-calls','--project',project,
          ...(selection.service ? ['--service',selection.service] : []),
          '--revision',snapshot.revision,'--output-dir',output],project);
        if (alive && current === epoch && getSnapshot() === snapshot) send(result);
      } catch (error) {
        if (alive && current === epoch && getSnapshot() === snapshot)
          send({revision:snapshot.revision,status:'failed',message:String(error)});
      }
    },
    dispose() { alive=false; ++epoch; },
  };
}

module.exports = {attachSubstreamCalls};
