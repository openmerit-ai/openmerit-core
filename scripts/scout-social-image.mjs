import { readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

// Regenerate the checked-in card after editing scout/social-image.svg.
const svg = await readFile(new URL('../scout/social-image.svg', import.meta.url), 'utf8');
const font = await readFile(new URL('../site/assets/inter-latin.woff2', import.meta.url));
const png = new Resvg(svg, {
  font: { fontBuffers: [font], loadSystemFonts: false },
}).render().asPng();
await writeFile(new URL('../site/scout/scout-og.png', import.meta.url), png);
console.log('Rendered site/scout/scout-og.png (1200 × 630).');
