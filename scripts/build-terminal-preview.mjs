import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { buildTerminal } from './build-terminal.mjs';
import { terminalSocialImage } from './terminal-social-image.mjs';

await buildTerminal();
const output = new URL('../dist/terminal-preview/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../packages/terminal/public/', import.meta.url), output, { recursive: true });
const social = await terminalSocialImage();
await writeFile(new URL(social.filename, output), social.png);
const imageUrl = `https://dash.openmerit.site/${social.filename}`;
const page = new URL('index.html', output);
let html = await readFile(page, 'utf8');
html = html.replace('<title>Inference Terminal · OpenMerit</title>', `<title>${social.title}</title>
    <meta name="description" content="Explore a fictional inference environment with 40 agents, 140 tasks, and 21 models. A sample preview of OpenMerit's Inference Terminal.">
    <meta name="robots" content="noindex, nofollow">
    <meta property="og:title" content="${social.title}">
    <meta property="og:description" content="An interactive sample of your inference environment, in one place. All names, activity, and hardware are fictional.">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://dash.openmerit.site/">
    <meta property="og:site_name" content="OpenMerit">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:secure_url" content="${imageUrl}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="${social.width}">
    <meta property="og:image:height" content="${social.height}">
    <meta property="og:image:alt" content="${social.alt}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${social.title}">
    <meta name="twitter:description" content="An interactive sample of your inference environment, in one place. All names, activity, and hardware are fictional.">
    <meta name="twitter:image" content="${imageUrl}">
    <meta name="twitter:image:alt" content="${social.alt}">`);
html = html.replace('<html lang="en">', '<html lang="en" data-sample-preview>');
html = html.replace('Reading your environment…', 'Opening the sample environment…').replace('the local JSON snapshot', 'the fictional JSON snapshot').replace('href="/api/snapshot"', 'href="/api/sample"');
await writeFile(page, html);
console.log('Built sample-only terminal assets in dist/terminal-preview.');
