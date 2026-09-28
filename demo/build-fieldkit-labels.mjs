// Reproducible synthetic vision fixtures. PNGs are input artifacts, not outputs.
import {Resvg} from '@resvg/resvg-js';
import {mkdir,writeFile} from 'node:fs/promises';
import {smoke,fixtures,verification} from './runtime/fieldkit.mjs';
const dir=new URL('./runtime/fieldkit-labels/',import.meta.url);
await mkdir(dir,{recursive:true});
for(const f of [smoke,...fixtures,...verification]) {
  const l=f.label;
  const rows=[l.kit_id,`Battery: ${l.battery_wh} Wh`,`Storage: ${l.storage_gb} GB`,`Max sample rate: ${l.max_sample_rate_khz} kHz`,`Connector: ${l.connector}`];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><rect width="420" height="180" fill="white"/><rect x="4" y="4" width="412" height="172" fill="none" stroke="black"/>${rows.map((row,i)=>`<text x="20" y="${30+i*30}" font-family="Arial" font-size="20" fill="black">${row}</text>`).join('')}</svg>`;
  await writeFile(new URL(`${f.kitId}.png`,dir),new Resvg(svg).render().asPng());
}
console.log('Built nine synthetic field-kit labels.');
