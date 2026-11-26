import TurndownService from 'turndown';

// Converts one of the site's own pages to the Markdown that AI agents get when
// they ask for text/markdown: front matter from its metadata, then its <main>.
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
// Decorations, icons, video controls and the form's fields carry no content for an agent.
turndown.remove(['script', 'style', 'button', 'input', 'select', 'textarea', 'label']);
turndown.remove(node => node.nodeName.toLowerCase() === 'svg' || node.getAttribute('aria-hidden') === 'true' || node.classList.contains('film-controls') || node.classList.contains('film-status'));
turndown.addRule('video', { filter: 'video', replacement: (_content, node) => {
  const video = node as HTMLVideoElement;
  return `[${video.getAttribute('aria-label') ?? 'Video'}](${video.querySelector('source')?.getAttribute('src') ?? ''})`;
} });
turndown.addRule('table', { filter: 'table', replacement: content => `\n\n${content.trim()}\n\n` });
turndown.addRule('tableSection', { filter: ['thead', 'tbody'], replacement: content => content });
turndown.addRule('tableRow', { filter: 'tr', replacement: (content, node) => {
  const row = `|${content}\n`;
  return node.parentNode?.nodeName === 'THEAD' ? `${row}|${' --- |'.repeat(node.querySelectorAll('th, td').length)}\n` : row;
} });
turndown.addRule('tableCell', { filter: ['th', 'td'], replacement: content => ` ${content.trim().replace(/\n+/g, ' ').replace(/\|/g, '\\|')} |` });
turndown.addRule('term', { filter: 'dt', replacement: content => `\n\n**${content.trim()}**\n` });
turndown.addRule('definition', { filter: 'dd', replacement: content => `${content.trim()}\n\n` });

const attribute = (html: string, pattern: RegExp) => html.match(pattern)?.[1]?.replace(/&amp;/g, '&');
const yaml = (value: string) => JSON.stringify(value);

export function pageMarkdown(html: string, origin: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*)<\/main>/)?.[1];
  if (!main) throw new Error('Page has no <main> element.');
  // Root-relative links and media become absolute, so they still work outside the page.
  const body = turndown.turndown(main.replace(/\b(href|src)="\/(?!\/)/g, `$1="${origin}/`));
  const title = attribute(html, /<title>([^<]*)<\/title>/);
  const description = attribute(html, /<meta name="description" content="([^"]*)"/);
  const url = attribute(html, /<link rel="canonical" href="([^"]*)"/);
  const front = [title && `title: ${yaml(title)}`, description && `description: ${yaml(description)}`, url && `url: ${yaml(url)}`].filter(Boolean);
  const tidy = body.replace(/^[ \t]+$/gm, '').replace(/^ +\[/gm, '[').replace(/\n{3,}/g, '\n\n').trim();
  return `${front.length ? `---\n${front.join('\n')}\n---\n\n` : ''}${tidy}\n`;
}
