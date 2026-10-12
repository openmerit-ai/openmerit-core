import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

const font = await readFile(new URL('../site/assets/inter-latin.woff2', import.meta.url));
const workshop = await readFile(new URL('../site/assets/openmerit-og-workshop-v1.png', import.meta.url));
const renderOptions = { font: { fontBuffers: [font], loadSystemFonts: false } };
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const measurements = new Map();
const width = 1200;
const height = 630;

function measure(text, size) {
  const key = `${size}:${text}`;
  if (!measurements.has(key)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="200"><text y="100" font-family="Inter" font-size="${size}">${escape(text)}</text></svg>`;
    const bounds = new Resvg(svg, renderOptions).innerBBox();
    if (!bounds) throw new Error('Unable to measure social image text with the bundled Inter font');
    measurements.set(key, bounds.x + bounds.width);
  }
  return measurements.get(key);
}

function wrap(text, size, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (measure(word, size) > maxWidth) return null;
    const next = line ? `${line} ${word}` : word;
    if (measure(next, size) <= maxWidth) line = next;
    else {
      lines.push(line);
      if (lines.length === maxLines) return null;
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fit(text, { maxWidth, maxLines, size, minSize }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Social image title must be nonempty text');
  for (; size >= minSize; size -= 2) {
    const lines = wrap(text, size, maxWidth, maxLines);
    if (lines && lines.length <= maxLines) return { lines, size };
  }
  throw new Error(`Social image text is too long to fit: ${text}`);
}

function textBlock({ lines, size }, { x, y, lineHeight, fill }) {
  return `<text font-family="Inter" font-size="${size}" letter-spacing="-2" fill="${fill}">${lines.map((line, index) => `<tspan x="${x}" y="${y + index * lineHeight}">${escape(line)}</tspan>`).join('')}</text>`;
}

// The same template can render another page by passing its maintained metadata.
export function createSocialImage({ title, url }) {
  const heading = fit(title, { maxWidth: 820, maxLines: 2, size: 76, minSize: 52 });
  const address = new URL(url, 'https://openmerit.ai');
  if (address.origin !== 'https://openmerit.ai') throw new Error('Social image must describe an OpenMerit page');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image width="1200" height="630" href="data:image/png;base64,${workshop.toString('base64')}"/>
    ${textBlock(heading, { x: 68, y: 133, lineHeight: 72, fill: '#30312d' })}
  </svg>`;
  const png = new Resvg(svg, renderOptions).render().asPng();
  const revision = createHash('sha256').update(png).digest('hex').slice(0, 12);
  return { png, svg, revision, width, height, type: 'image/png', alt: `${title}. Three miniature makers compare tools at a wooden workbench, with a resting spaniel.` };
}
