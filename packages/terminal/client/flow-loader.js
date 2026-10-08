let modulePromise;
let implementation;
let revision = 0;

// Opt-in, separately bundled: the original map does not download React Flow or ELK.
export async function syncFlowMap(props) {
  const current = ++revision;
  const host = document.querySelector('[data-flow-map]');
  if (!host) { implementation?.renderFlowMap(null); return; }
  if (!document.getElementById('flow-map-styles')) {
    const stylesheet = document.createElement('link'); stylesheet.id = 'flow-map-styles'; stylesheet.rel = 'stylesheet'; stylesheet.href = '/flow.css'; document.head.append(stylesheet);
  }
  try {
    implementation = await (modulePromise ??= import('/flow.js'));
    if (current === revision && host.isConnected) implementation.renderFlowMap(host, props);
  } catch {
    modulePromise = null;
    if (current === revision && host.isConnected) host.textContent = 'The map preview could not load. Use Original map to continue.';
  }
}
