(() => {
  const vscode = acquireVsCodeApi();
  window.addEventListener('service-architect:selection', event => {
    vscode.postMessage({ type: 'navigate', selection: event.detail });
  });
  window.addEventListener('load', () => vscode.postMessage({ type: 'ready' }), { once: true });
})();
