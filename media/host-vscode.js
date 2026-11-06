(() => {
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', event => {
    const message = event.data;
    if (['service-architect:editor-selection', 'service-architect:code-calls'].includes(message?.type)) {
      window.dispatchEvent(new CustomEvent(message.type,{detail:message}));
      return;
    }
    if (!message || message.type !== 'service-architect:snapshot' ||
        !message.snapshot || typeof message.snapshot !== 'object') return;
    window.__SERVICE_ARCHITECT_SNAPSHOT__ = message.snapshot;
    window.dispatchEvent(new CustomEvent('service-architect:snapshot', { detail: message.snapshot }));
  });
  window.addEventListener('service-architect:selection', event => {
    vscode.postMessage({ type: 'navigate', selection: event.detail });
  });
  window.addEventListener('service-architect:refresh', () => vscode.postMessage({type:'refresh'}));
  window.addEventListener('load', () => vscode.postMessage({ type: 'ready' }), { once: true });
})();
