export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, main, { script = false, sharingMetadata = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f8f7f4" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#171915" media="(prefers-color-scheme: dark)"><meta name="robots" content="noindex, nofollow, noarchive">
<title>${escapeHtml(title)} · OpenMerit</title>
${sharingMetadata}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/memo.css"><link rel="stylesheet" href="/memo-access.css">
${script ? '<script src="/memo-access.js" defer></script>' : ''}
</head><body class="memo-page memo-access-page">
<a class="skip-link" href="#access-content">Skip to content</a>
<header class="memo-header wrap"><a class="brand" href="/" aria-label="OpenMerit home"><svg class="brand-mark" viewBox="0 0 28 30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M3 27V13a11 11 0 0 1 22 0v14M8 27V13a6 6 0 0 1 12 0v14M14 16v11"/></svg><span>openmerit</span></a><nav class="memo-nav" aria-label="Primary navigation"><a href="/">Home</a></nav></header>
<main id="access-content" class="memo-access-main" tabindex="-1">${main}</main>
</body></html>`;
}

export function loginPage({ admin = false, sharingMetadata = '' } = {}) {
  return page(admin ? 'Memo readers' : 'Read the memo', `
<p class="memo-access-eyebrow">${admin ? 'Private reader list' : 'A memo by Lazim Aslam and Akhil Aryan'}</p>
<h1>${admin ? 'Memo readers' : 'Optimum Inference for All'}</h1>
<p class="memo-access-intro">${admin ? 'Verify your admin email to see who has opened the memo.' : 'Enter your email to read the memo. We’ll send you a one-time code.'}</p>
<form class="memo-access-form" data-memo-login data-destination="${admin ? '/memo/readers/' : '/memo/'}">
  <div data-email-step><label for="memo-email">Email address</label><input id="memo-email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" required placeholder="you@example.com"><button class="memo-access-submit" type="submit">Send code <span aria-hidden="true">→</span></button></div>
  <div data-code-step hidden><p class="memo-code-sent">We sent a code to <strong data-sent-to></strong>.</p><label for="memo-code">Verification code</label><input id="memo-code" name="code" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" enterkeyhint="go" placeholder="000000" disabled><button class="memo-access-submit" type="submit">${admin ? 'View readers' : 'Read memo'} <span aria-hidden="true">→</span></button><div class="memo-access-actions"><button type="button" data-change-email>Use another email</button><button type="button" data-resend>Resend code</button></div></div>
  <p class="memo-access-status" role="status" aria-live="polite" data-status></p>
</form>
${admin ? '<p class="memo-access-note">Access is limited to approved admin addresses.</p>' : ''}
<noscript><p>Please enable JavaScript to verify your email.</p></noscript>`, { script: true, sharingMetadata: admin ? '' : sharingMetadata });
}

export function messagePage(title, message) {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="memo-access-intro">${escapeHtml(message)}</p><p><a class="memo-access-link" href="/memo/">Back to the memo</a></p>`);
}

export function readersPage(rows) {
  const date = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return page('Memo readers', `<p class="memo-access-eyebrow">Private reader list</p><h1>Memo readers</h1>
<p class="memo-access-intro">${rows.length} verified ${rows.length === 1 ? 'reader' : 'readers'}. Visits count page loads, including reloads.</p>
<div class="memo-reader-actions"><a class="memo-access-link" href="/memo/readers/export.csv">Download CSV</a><a class="memo-access-link" href="/memo/">Read memo</a><button type="button" class="memo-access-link" data-memo-signout>Sign out</button></div>
${rows.length ? `<div class="memo-readers-scroll" role="region" aria-label="Memo readers" tabindex="0"><table><thead><tr><th>Email</th><th>First visit</th><th>Latest visit</th><th>Visits</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.email)}</td><td>${date(r.first_opened_at)}</td><td>${date(r.last_opened_at)}</td><td>${r.visits}</td></tr>`).join('')}</tbody></table></div>` : '<p>No one has opened the memo yet.</p>'}
<p role="status" data-status></p>`, { script: true });
}

export function readerCsv(rows) {
  const cell = value => '"' + String(value).replace(/^[=+@\-\t\r\n]/, "'$&").replaceAll('"', '""') + '"';
  return '\uFEFF' + [['Email', 'First visit (UTC)', 'Latest visit (UTC)', 'Visits'], ...rows.map(r => [r.email, new Date(r.first_opened_at).toISOString(), new Date(r.last_opened_at).toISOString(), r.visits])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
