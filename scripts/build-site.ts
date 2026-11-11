// Build the protected memo and the browser scripts, not a documentation website.
import {rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {buildMemo} from './build-memo.mjs';
import './build-browser.ts';

const root = resolve(import.meta.dirname, '..');
await buildMemo(root);
// Never leave a previous docs-site or Scout data policy build available to local previews or uploads.
await rm(join(root, 'site/docs'), {recursive: true, force: true});
await rm(join(root, 'site/scout/data-policy'), {recursive: true, force: true});
console.log('Built the protected memo and browser scripts.');
