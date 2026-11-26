// The contact-sales form at /contact-sales/: validates a submission and emails it to
// OpenMerit with Reply-To set to the sender. Nothing is stored.

export interface ContactEnv {
  CONTACT_EMAIL?: { send(message: ContactMessage): Promise<unknown> };
  CONTACT_RATE?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  CONTACT_TO?: string;
  CONTACT_FROM?: string;
}

interface ContactMessage {
  from: { name: string; email: string };
  to: string[];
  replyTo: { name: string; email: string };
  subject: string;
  text: string;
}

export const companySizes = ['1–10', '11–50', '51–200', '201–1,000', '1,001+'];
export const llmSpends = ['Under $10K', '$10K–$25K', '$25K–$50K', '$50K–$100K', '$100K–$250K', '$250K–$500K', '$500K–$1M', '$1M+'];
const limits = { name: 120, email: 254, company: 160, use: 4000, heard: 500 };

function page(status: number, title: string, body: string) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="color-scheme" content="light dark">
  <title>${title} · OpenMerit</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/styles.css?v=20261126-contact-v4">
</head>
<body class="landing-page">
  <main class="letter-main compare-page">
    <h1>${title}</h1>
    <p class="compare-lede">${body}</p>
  </main>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

const fallback = (to: string) => `You can also email <a href="mailto:${to}">${to}</a>.`;
const back = '<a href="/contact-sales/">Back to the form</a>.';

export async function contactSubmit(request: Request, env: ContactEnv): Promise<Response> {
  const to = env.CONTACT_TO ?? '';
  if (request.method !== 'POST') return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!env.CONTACT_EMAIL || !to || !env.CONTACT_FROM) return page(503, 'The form is unavailable', `Please try again later. ${fallback(to || 'lazim@openmerit.ai')}`);

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (env.CONTACT_RATE && !(await env.CONTACT_RATE.limit({ key: ip })).success) {
    return page(429, 'Too many requests', `Please wait a minute and try again. ${fallback(to)}`);
  }

  let form: FormData;
  try { form = await request.formData(); } catch { return page(400, 'Something is missing', `Please fill in the form again. ${back}`); }
  const field = (name: string) => String(form.get(name) ?? '').trim();
  // Bots fill the hidden field; people never see it. Pretend it worked.
  if (field('website')) return Response.redirect(new URL('/contact-sales/thanks/', request.url).href, 303);

  const entry = { name: field('name'), email: field('email'), company: field('company'), size: field('size'), spend: field('spend'), use: field('use'), heard: field('heard') };
  const valid = entry.name && entry.company && companySizes.includes(entry.size) && llmSpends.includes(entry.spend)
    && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(entry.email)
    && (Object.keys(limits) as (keyof typeof limits)[]).every(key => entry[key].length <= limits[key]);
  if (!valid) return page(400, 'Something is missing', `Please give your name, a work email, your company, its size and its monthly LLM spend. ${back}`);

  const name = entry.name.replace(/[\r\n]+/g, ' ');
  try {
    await env.CONTACT_EMAIL.send({
      from: { name: 'OpenMerit website', email: env.CONTACT_FROM },
      to: [to],
      replyTo: { name, email: entry.email },
      subject: `OpenMerit Cloud enquiry: ${entry.company.replace(/[\r\n]+/g, ' ')}`.slice(0, 200),
      text: [
        `Name: ${name}`, `Work email: ${entry.email}`, `Company: ${entry.company}`, `Company size: ${entry.size}`, `Monthly LLM spend: ${entry.spend}`,
        '', 'What they want OpenMerit for:', entry.use || '(not given)',
        '', 'How they heard about OpenMerit:', entry.heard || '(not given)',
        '', 'Reply to this email to answer them.',
      ].join('\n'),
    });
  } catch {
    return page(502, 'We couldn’t send that', `Your message didn’t go through. ${fallback(to)}`);
  }
  return Response.redirect(new URL('/contact-sales/thanks/', request.url).href, 303);
}
