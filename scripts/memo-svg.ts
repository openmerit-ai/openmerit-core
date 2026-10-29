import MarkdownIt from 'markdown-it';

const { unescapeAll } = new MarkdownIt().utils;
const escape = (value: string) => unescapeAll(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const elements = new Set(['svg', 'g', 'defs', 'marker', 'text', 'title', 'path', 'line', 'rect', 'circle']);
const attributes = new Set(['viewBox', 'role', 'aria-label', 'font-size', 'font-weight', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'text-anchor', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'width', 'height', 'd', 'transform', 'id', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'marker-end']);

// A deliberately small, static SVG vocabulary preserves the supplied vectors.
// Rebuild markup from allowed elements/attributes; never enable raw Markdown HTML.
export function renderMemoSvg(source: string, index: number) {
  const parts = source.trim().match(/<[^>]*>|[^<]+/g) ?? [];
  if (parts.join('') !== source.trim()) throw new Error('Malformed memo SVG');
  const stack: string[] = [];
  let label: string | undefined;
  let roots = 0;
  const svg = parts.map(part => {
    if (!part.startsWith('<')) {
      if (part.trim() && !['text', 'title'].includes(stack.at(-1) || '')) throw new Error('Memo SVG text must be inside a text element');
      return escape(part);
    }
    const close = part.match(/^<\/([a-z]+)>$/);
    if (close) {
      if (stack.pop() !== close[1]) throw new Error('Unbalanced memo SVG');
      return part;
    }
    const open = part.match(/^<([a-z]+)\b([\s\S]*?)(\/?)>$/);
    if (!open || !elements.has(open[1]!)) throw new Error('Unsupported memo SVG element');
    const tag = open[1]!, raw = open[2]!, selfClosing = open[3]!;
    if (tag === 'svg') {
      if (stack.length || ++roots > 1) throw new Error('Memo figure needs one SVG');
    } else if (!stack.length) throw new Error('Memo SVG needs a root');
    const seen = new Set<string>();
    const attrs: string[] = [];
    const leftover = raw.replace(/\s+([\w-]+)="([^"<>]*)"/g, (_: string, name: string, value: string) => {
      if (!attributes.has(name) || seen.has(name)) throw new Error(`Unsupported memo SVG attribute: ${name}`);
      seen.add(name);
      if (name === 'id') {
        if (!/^[a-z][\w-]*$/.test(value)) throw new Error('Invalid memo SVG ID');
        value = `memo-vector-${index}-${value}`;
      }
      if (name === 'marker-end') {
        if (!/^url\(#[a-z][\w-]*\)$/.test(value)) throw new Error('Memo SVG markers must be local');
        value = value.replace('url(#', `url(#memo-vector-${index}-`);
      }
      if (['fill', 'stroke'].includes(name) && !/^(none|currentColor|#[\da-fA-F]{3,8}|var\(--cds-[a-z0-9-]+\))$/.test(value)) throw new Error('Unsupported memo SVG color');
      if (tag === 'svg' && name === 'aria-label') label = value;
      attrs.push(`${name}="${escape(value)}"`);
      return '';
    });
    if (leftover.trim()) throw new Error('Malformed memo SVG attributes');
    if (!selfClosing) stack.push(tag);
    return `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}${selfClosing ? '/' : ''}>`;
  }).join('');
  if (roots !== 1 || stack.length || !label) throw new Error('Memo SVG needs a complete labelled root');
  return `<figure class="memo-vector" id="memo-figure-${index}"><div class="memo-vector-scroll" role="region" aria-label="${escape(label)}" tabindex="0">${svg}</div><figcaption class="memo-vector-hint">Scroll to explore the diagram <span aria-hidden="true">→</span></figcaption></figure>\n`;
}
