// OpenMerit device approval. A coding agent's `openmerit install` shows a code;
// the signed-in person confirms it here. The page never sees the device key.
import { analytics } from '../scout/analytics.js';
import { showLangfuse } from './langfuse.js';

const $ = selector => document.querySelector(selector);
const status = $('#connect-status');
const params = new URLSearchParams(location.search);
let code = (params.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
const candidate = params.get('setup_id');
let setupId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : undefined;
let stage = 'auth';
const reported = new WeakSet();
function clientError(at, error, code = 'uncaught_error') {
  if (error && typeof error === 'object') { if (reported.has(error)) return; reported.add(error); }
  const httpStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
  const candidateCode = error?.telemetryCode ?? code;
  const safeCode = ['auth_unavailable', 'network_error', 'http_error', 'approval_timeout', 'uncaught_error'].includes(candidateCode) ? candidateCode : 'uncaught_error';
  analytics.track('scout_connect_client_error', { stage: at, code: httpStatus ? 'http_error' : safeCode,
    ...(httpStatus ? { http_status: httpStatus } : {}), ...(linkedSetup() ? { setup_id: setupId } : {}) });
}
function linkedSetup() {
  const settings = analytics.preferences();
  return setupId && settings.enabled && settings.linkAccount;
}
window.addEventListener('scout-analytics-change', () => { if (!linkedSetup()) setupId = undefined; });
window.addEventListener('error', event => clientError(stage, event.error));
window.addEventListener('unhandledrejection', event => clientError(stage, event.reason));

function say(text, error = false) { status.textContent = text; status.classList.toggle('connect-error', error); status.hidden = !text; }
function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    const fail = () => { clearTimeout(timeout); script.remove(); reject(new Error('Sign-in could not load. Please try again.')); };
    const timeout = setTimeout(fail, 15_000);
    script.onload = () => { clearTimeout(timeout); resolve(); }; script.onerror = fail;
    document.head.append(script);
  });
}
async function clerk() {
  const response = await fetch('/scout/api/auth');
  if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again later.');
  const { publishableKey, frontendApi, analytics: config } = await response.json();
  analytics.configure(config?.enabled, config?.accountSync, config?.content, config?.contentDefault, {
    page: 'connect', usage: params.get('analytics') !== 'off', linkAccount: params.get('analytics_account') !== 'off',
  });
  await Promise.all([
    window.__internal_ClerkUICtor || loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
    window.Clerk || loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
  ]);
  const returnUrl = location.href;
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, telemetry: false, signInForceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, afterSignOutUrl: returnUrl });
  return window.Clerk;
}
async function api(client, path, options = {}) {
  let token;
  try { token = await client.session?.getToken(); if (!token) throw new Error('Sign in again to continue.'); }
  catch { throw Object.assign(new Error('Sign in again to continue.'), { telemetryCode: 'auth_unavailable' }); }
  let response;
  try {
    response = await fetch(`/connect/api/${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...analytics.headers(), ...(linkedSetup() ? { 'X-Scout-Setup-Id': setupId } : {}) } });
  } catch { throw Object.assign(new Error('Couldn’t reach Scout. Check the connection and try again.'), { telemetryCode: 'network_error' }); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Something went wrong. Please try again.'), { status: response.status });
  return body;
}

async function showDevices(client) {
  try {
    const { keys } = await api(client, 'keys');
    $('#devices').hidden = !keys.length;
    $('#device-list').replaceChildren(...keys.map(key => {
      const item = document.createElement('li'), label = document.createElement('div'), meta = document.createElement('span'), revoke = document.createElement('button');
      label.textContent = `${key.clientName} on ${key.deviceName}`;
      meta.textContent = ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}`; label.append(meta);
      revoke.type = 'button'; revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try { await api(client, `keys/${key.id}`, { method: 'DELETE' }); await showDevices(client); }
        catch (error) { clientError('revoke', error); say(error.message, true); revoke.disabled = false; }
      });
      item.append(label, revoke); return item;
    }));
  } catch (error) { clientError('devices', error); throw error; }
}

// A collected key proves authorization, not installation or a working agent.
async function showConnected(client, login) {
  say(`Authorized. Waiting for ${login.clientName} to collect its key…`);
  let pollFailed = false;
  for (let i = 0; i < 60; i++) {
    const current = await api(client, `login?code=${encodeURIComponent(code)}`).catch(error => {
      if (!pollFailed) clientError('poll', error);
      pollFailed = true; return null;
    });
    if (current?.status === 'collected') {
      $('#connect-title').textContent = `${login.clientName} key authorized`;
      say(`Key collected. Return to ${login.clientName} to check the installation result. This page does not verify installation.`);
      $('#connect-status').classList.add('connect-success');
      await showDevices(client).catch(() => {});
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  clientError('poll', null, 'approval_timeout');
  say(`Authorized. Return to ${login.clientName} to check setup; key collection was not confirmed here.`);
}

async function showRequest(client) {
  $('#code-form').hidden = true;
  let login;
  try { login = await api(client, `login?code=${encodeURIComponent(code)}`); }
  catch (error) { clientError('load', error); say(error.message, true); $('#code-form').hidden = false; return; }
  if (['approved', 'collected'].includes(login.status)) return showConnected(client, login);
  if (login.status !== 'pending') {
    say(login.status === 'expired' ? 'This code has expired. Run the install command again for a new code.' : 'This request was denied. Nothing was connected.', login.status === 'expired');
    return;
  }
  say('');
  $('#request-client').textContent = login.clientName;
  $('#request-device').textContent = login.deviceName;
  $('#request-scope').textContent = login.scope === 'user' ? 'All your projects (user scope)' : 'One project (project scope)';
  $('#request-code').textContent = code;
  $('#request').hidden = false;
  for (const [button, decision] of [[$('#approve'), 'approve'], [$('#deny'), 'deny']]) button.onclick = async () => {
    $('#approve').disabled = $('#deny').disabled = true;
    try {
      await api(client, 'login', { method: 'POST', body: JSON.stringify({ code, decision }) });
      $('#request').hidden = true;
      if (decision === 'approve') await showConnected(client, login);
      else { say('Denied. Nothing was connected.'); await showDevices(client); }
    } catch (error) { clientError(decision, error); say(error.message, true); $('#approve').disabled = $('#deny').disabled = false; }
  };
}

try {
  const client = await clerk();
  const observeAccount = ({ user = client.user, session = client.session } = {}) => {
    const active = session?.status === 'active';
    analytics.account(active ? user?.id ?? null : null, active ? session : null, client.client?.signIn);
  };
  observeAccount();
  client.addListener(observeAccount);
  stage = 'load';
  if (client.session?.status !== 'active') {
    say('Sign in to approve this coding agent.');
    client.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  } else {
    client.mountUserButton($('#user-account')); $('#user-account').hidden = false;
    $('#code-form').addEventListener('submit', event => {
      event.preventDefault();
      code = $('#code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
      const query = new URLSearchParams({ code });
      if (linkedSetup()) query.set('setup_id', setupId);
      for (const key of ['analytics', 'analytics_account']) if (params.get(key) === 'off') query.set(key, 'off');
      history.replaceState(null, '', `/connect/?${query}`);
      void showRequest(client).catch(error => { clientError('load', error); say(error.message, true); });
    });
    if (code) await showRequest(client);
    else if (params.get('integration') === 'langfuse') { $('#connect-title').textContent = 'Your connections'; say('Manage your connected evals below.'); }
    else { say(''); $('#code-form').hidden = false; }
    await showDevices(client).catch(() => {});
    await showLangfuse((path, options) => api(client, path, options));
  }
} catch (error) { clientError(stage, error, stage === 'auth' ? 'auth_unavailable' : 'uncaught_error'); say(error.message, true); }
