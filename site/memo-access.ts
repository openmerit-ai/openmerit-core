export {};
const form = document.querySelector<HTMLFormElement>('[data-memo-login]');
const status = document.querySelector<HTMLElement>('[data-status]');
const say = (message: string, error = false) => { if (status) { status.textContent = message; status.dataset.error = String(error); } };
async function authRequest(path: string, body: Record<string, string>) {
  const response = await fetch(`/memo/auth/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => ({}));
    throw new Error(data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : 'Unable to continue. Please try again.');
  }
}
if (form) {
  const email = form.querySelector<HTMLInputElement>('#memo-email')!, code = form.querySelector<HTMLInputElement>('#memo-code')!;
  const emailStep = form.querySelector<HTMLElement>('[data-email-step]')!, codeStep = form.querySelector<HTMLElement>('[data-code-step]')!;
  const resend = form.querySelector<HTMLButtonElement>('[data-resend]')!;
  let verifying = false, busy = false, resendAt = 0;
  function setBusy(value: boolean) {
    busy = value;
    form!.querySelectorAll('button').forEach(b => { b.disabled = value; });
    form!.setAttribute('aria-busy', String(value));
    email.readOnly = value;
    code.readOnly = value;
    refreshResend();
  }
  function refreshResend() {
    const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    resend.disabled = busy || seconds > 0;
    resend.textContent = seconds ? `Resend in ${seconds}s` : 'Resend code';
  }
  async function sendCode() {
    await authRequest('email-otp/send-verification-otp', { email: email.value.trim(), type: 'sign-in' });
    resendAt = Date.now() + 60000;
    verifying = true; emailStep.hidden = true; codeStep.hidden = false;
    email.disabled = true; code.disabled = false; code.required = true; code.value = '';
    form!.querySelector('[data-sent-to]')!.textContent = email.value.trim();
    say('The code expires in 10 minutes. Check your spam folder if it hasn’t arrived.');
    code.focus();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); say(verifying ? 'Verifying…' : 'Sending code…');
    try {
      if (verifying) {
        await authRequest('sign-in/email-otp', { email: email.value.trim(), otp: code.value.trim() });
        // Only a server-rendered, fixed destination can be used here.
        location.assign(form.dataset.destination === '/memo/readers/' ? '/memo/readers/' : '/memo/' + location.hash);
      } else await sendCode();
    } catch (error) { say(error instanceof TypeError ? 'Connection interrupted. Please try again.' : error instanceof Error ? error.message : 'Unable to continue.', true); }
    finally { setBusy(false); }
  });
  resend.addEventListener('click', async () => {
    if (busy || Date.now() < resendAt) return;
    setBusy(true); say('Sending a new code…');
    try { await sendCode(); } catch (error) { say(error instanceof Error ? error.message : 'Unable to continue.', true); } finally { setBusy(false); }
  });
  form.querySelector('[data-change-email]')!.addEventListener('click', () => {
    verifying = false; emailStep.hidden = false; codeStep.hidden = true;
    email.disabled = false; code.disabled = true; code.required = false; code.value = ''; say(''); email.focus();
  });
  setInterval(refreshResend, 1000);
}
document.querySelectorAll<HTMLButtonElement>('[data-memo-signout]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try { await authRequest('sign-out', {}); location.assign('/memo/'); }
  catch { say('Unable to sign out. Please try again.', true); button.disabled = false; }
}));
