// Credentials exist only in these password fields until the authenticated POST.
// No browser storage, URL parameters or analytics receive them.
type Api = (path: string, options?: RequestInit) => Promise<Record<string, unknown>>;
function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing connection control: ${id}`);
  return node as T;
}
export function showConnectionPermissions(permissions: string[]): void {
  element('request-permissions').textContent = permissions.includes('scout:connections')
    ? 'Manage your account’s Langfuse connection through CLI, MCP or API: add or replace the Viewer key, sync aggregates, disconnect, or delete all evaluation data. No recommendations, code access or spending.'
    : 'Scout model recommendations through MCP. No code access, spending or other permissions.';
}
export async function showLangfuse(api: Api): Promise<void> {
  const section = element('langfuse'), form = element<HTMLFormElement>('langfuse-form');
  const status = element('langfuse-status'), connected = element('langfuse-connected');
  const region = element<HTMLSelectElement>('langfuse-region');
  const publicKey = element<HTMLInputElement>('langfuse-public-key'), secretKey = element<HTMLInputElement>('langfuse-secret-key');
  const from = element<HTMLInputElement>('langfuse-from');
  from.value = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const link = element<HTMLAnchorElement>('langfuse-key-link');
  const hosts = { us: 'https://us.cloud.langfuse.com', eu: 'https://cloud.langfuse.com', hipaa: 'https://hipaa.cloud.langfuse.com' };
  region.addEventListener('change', () => { link.href = hosts[region.value as keyof typeof hosts]; });
  const say = (message: string, error = false) => { status.textContent = message; status.classList.toggle('connect-error', error); };
  const refresh = async () => {
    const state = await api('langfuse');
    form.hidden = !!state.connected;
    connected.hidden = !state.connected;
    const missing = [state.mappingCount === 0 ? 'score mappings' : '', state.modelAliasCount === 0 ? 'model aliases' : ''].filter(Boolean);
    const emptySync = !!state.syncedAt && state.results === 0;
    say(state.connected
      ? missing.length ? `Key connected, setup incomplete. Reconnect with ${missing.join(' and ')} to import results. Your tracing keys stay unchanged.`
        : `Connected · ${state.results ?? 0} account aggregates${state.syncedAt ? ` · last sync ${new Date(Number(state.syncedAt)).toLocaleString()}` : ' · not synced yet'}${Number(state.unmapped) ? ` · ${state.unmapped} mappings need a model alias` : ''}${emptySync ? ' · no matching scores imported; check experiment tags, trace names and metric names' : ''}`
      : 'Connect a separate Viewer key. Your tracing keys stay unchanged.', !!state.connected && (missing.length > 0 || emptySync));
  };
  section.hidden = false;
  try { await refresh(); } catch { say('Connection status is unavailable. Try again shortly.', true); }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = element<HTMLButtonElement>('langfuse-save'); button.disabled = true;
    try {
      let mappings: unknown, models: unknown;
      try {
        mappings = JSON.parse(element<HTMLTextAreaElement>('langfuse-mappings').value || '[]');
        models = JSON.parse(element<HTMLTextAreaElement>('langfuse-models').value || '{}');
      } catch { throw new Error('Score mappings and model aliases must be valid JSON.'); }
      say('Checking read-only access…');
      await api('langfuse', { method: 'POST', body: JSON.stringify({ region: region.value, publicKey: publicKey.value.trim(), secretKey: secretKey.value.trim(), from: from.value,
        tagPrefix: element<HTMLInputElement>('langfuse-tag-prefix').value, mappings, models }) });
      await refresh();
    } catch (error) { say(error instanceof Error ? error.message : 'Could not connect Langfuse.', true); }
    finally { publicKey.value = ''; secretKey.value = ''; button.disabled = false; }
  });
  element<HTMLButtonElement>('langfuse-sync').addEventListener('click', async () => {
    const button = element<HTMLButtonElement>('langfuse-sync'); button.disabled = true;
    try { say('Reading aggregate metrics…'); await api('langfuse/sync', { method: 'POST' }); await refresh(); }
    catch (error) { say(error instanceof Error ? error.message : 'Could not sync Langfuse.', true); }
    finally { button.disabled = false; }
  });
  element('langfuse-disconnect').addEventListener('click', async () => {
    if (!window.confirm('Delete the Langfuse key and all imported aggregates? Manually reported aggregates and past conversations remain.')) return;
    try { await api('langfuse', { method: 'DELETE' }); await refresh(); }
    catch { say('Could not disconnect. Please retry.', true); }
  });
  element('evaluations-delete').addEventListener('click', async () => {
    if (!window.confirm('Delete all your evaluation aggregates and the Langfuse connection? Past conversations remain.')) return;
    try { await api('evaluations', { method: 'DELETE' }); await refresh(); }
    catch { say('Could not delete evaluation data. Please retry.', true); }
  });
}
