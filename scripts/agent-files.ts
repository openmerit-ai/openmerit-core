// Files that help search engines and AI assistants read openmerit.ai, built from the
// pages' own metadata and text so they never drift from what the pages say.
const origin = 'https://openmerit.ai';
const repository = 'https://github.com/openmerit-ai/openmerit-core';
const npmPackage = 'https://www.npmjs.com/package/openmerit';

export interface PageInfo { url: string; title: string; description: string }

const decode = (text: string) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const meta = (html: string, pattern: RegExp) => decode(html.match(pattern)?.[1] ?? '');

export function pageInfo(html: string, url: string): PageInfo {
  return {
    url: `${origin}${url}`,
    title: meta(html, /<title>([^<]*)<\/title>/).replace(/ · OpenMerit$/, ''),
    description: meta(html, /<meta name="description" content="([^"]*)"/),
  };
}

export function sitemap(pages: readonly PageInfo[]): string {
  const urls = pages.map(page => `  <url><loc>${page.url}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// https://llmstxt.org: a title, a one-line summary, then links with what each page answers.
export function llmsTxt(pages: readonly PageInfo[]): string {
  const [home, ...rest] = pages;
  const links = rest.map(page => `- [${page.title}](${page.url}): ${page.description}`).join('\n');
  return `# OpenMerit\n\n> ${home!.description}\n\nEvery page below is also served as Markdown when the request's Accept header lists text/markdown.\n\n## Pages\n\n${links}\n\n## Install\n\n- [openmerit on npm](${npmPackage}): \`npm install -g openmerit\`, then \`openmerit setup\` in your repository.\n- [Source on GitHub](${repository})\n`;
}

// JSON-LD for the homepage (who OpenMerit is and what the free CLI is) and for any page
// with a visible FAQ, which becomes a FAQPage with the same questions and answers.
export function structuredData(html: string, url: string): object | null {
  const { description } = pageInfo(html, url);
  if (url === '/') {
    const organization = { '@type': 'Organization', '@id': `${origin}/#organization`, name: 'OpenMerit', url: `${origin}/`, email: 'team@openmerit.ai', sameAs: [repository, npmPackage] };
    return {
      '@context': 'https://schema.org',
      '@graph': [
        organization,
        { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'OpenMerit', url: `${origin}/`, publisher: { '@id': organization['@id'] } },
        {
          '@type': 'SoftwareApplication', name: 'OpenMerit', url: `${origin}/`, description,
          applicationCategory: 'DeveloperApplication', operatingSystem: 'Linux, macOS',
          downloadUrl: npmPackage, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          publisher: { '@id': organization['@id'] },
        },
      ],
    };
  }
  const faq = html.match(/<dl class="compare-faq">([\s\S]*?)<\/dl>/)?.[1];
  if (!faq) return null;
  const entries = [...faq.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)].map(([, question, answer]) => ({
    '@type': 'Question', name: plain(question!), acceptedAnswer: { '@type': 'Answer', text: plain(answer!) },
  }));
  return entries.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: entries } : null;
}

export function withStructuredData(html: string, url: string): string {
  const data = structuredData(html, url);
  if (!data) return html;
  // Escape "<" so the JSON can never close its script element.
  const script = `  <script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n`;
  return html.replace('</head>', `${script}</head>`);
}
