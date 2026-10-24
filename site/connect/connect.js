// OpenMerit device approval. A coding agent's `openmerit install` shows a code;
// the signed-in person confirms it here. The page never sees the device key.
const $ = selector => document.querySelector(selector);
const status = $('#connect-status');
const params = new URLSearchParams(location.search);
let code = (params.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

function say(text, error = false) { status.textContent = text; status.classList.toggle('connect-error', error); status.hidden = !text; }
function loadScript(src, publishableKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.crossOrigin = 'anonymous';
    if (publishableKey) script.dataset.clerkPublishableKey = publishableKey;
    script.onload = resolve; script.onerror = () => reject(new Error('Sign-in could not load. Please try again.'));
    document.head.append(script);
  });
}
async function clerk() {
  const response = await fetch('/scout/api/auth');
  if (!response.ok) throw new Error('Sign-in is temporarily unavailable. Please try again later.');
  const { publishableKey, frontendApi } = await response.json();
  await Promise.all([
    window.__internal_ClerkUICtor || loadScript(`https://${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js`),
    window.Clerk || loadScript(`https://${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey),
  ]);
  const returnUrl = location.href;
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, telemetry: false, signInForceRedirectUrl: returnUrl, signUpForceRedirectUrl: returnUrl, afterSignOutUrl: returnUrl });
  return window.Clerk;
}
async function api(client, path, options = {}) {
  const token = await client.session.getToken();
  const response = await fetch(`/connect/api/${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Something went wrong. Please try again.'), { status: response.status });
  return body;
}

async function showDevices(client) {
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
      catch (error) { say(error.message, true); revoke.disabled = false; }
    });
    item.append(label, revoke); return item;
  }));
}

// Success means the CLI collected its key, not only that this page said yes.
async function showConnected(client, login) {
  say(`Waiting for ${login.clientName} to finish…`);
  for (let i = 0; i < 60; i++) {
    const current = await api(client, `login?code=${encodeURIComponent(code)}`).catch(() => null);
    if (current?.status === 'collected') {
      $('#connect-title').textContent = `${login.clientName} is connected`;
      say(`Scout is set up on ${login.deviceName}. You can close this tab; ${login.clientName} reports the result.`);
      $('#connect-status').classList.add('connect-success');
      await showDevices(client).catch(() => {});
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  say(`Approved. Return to ${login.clientName}; it finishes setup automatically.`);
}

async function showRequest(client) {
  $('#code-form').hidden = true;
  let login;
  try { login = await api(client, `login?code=${encodeURIComponent(code)}`); }
  catch (error) { say(error.message, true); $('#code-form').hidden = false; return; }
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
    } catch (error) { say(error.message, true); $('#approve').disabled = $('#deny').disabled = false; }
  };
}

try {
  const client = await clerk();
  if (client.session?.status !== 'active') {
    say('Sign in to approve this coding agent.');
    client.openSignIn({ forceRedirectUrl: location.href, signUpForceRedirectUrl: location.href });
  } else {
    client.mountUserButton($('#user-account')); $('#user-account').hidden = false;
    $('#code-form').addEventListener('submit', event => {
      event.preventDefault();
      code = $('#code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
      history.replaceState(null, '', `/connect/?code=${code}`);
      void showRequest(client);
    });
    if (code) await showRequest(client); else { say(''); $('#code-form').hidden = false; }
    await showDevices(client).catch(() => {});
  }
} catch (error) { say(error.message, true); }
