import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

export async function terminalSocialImage() {
  const svg = await readFile(new URL('../packages/terminal/hosted/social-image.svg', import.meta.url), 'utf8');
  const font = await readFile(new URL('../site/assets/inter-latin.woff2', import.meta.url));
  const png = new Resvg(svg, { font: { fontBuffers: [font], loadSystemFonts: false } }).render().asPng();
  const revision = createHash('sha256').update(png).digest('hex').slice(0, 12);
  return { png, filename: `inference-terminal-og-${revision}.png`, title: 'Inference Terminal by OpenMerit', width: 1200, height: 630, alt: 'Inference Terminal by OpenMerit. Blue, amber, violet, and cyan inference paths on a graphite background.' };
}
