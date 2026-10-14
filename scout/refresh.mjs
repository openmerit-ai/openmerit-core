import { readFile, writeFile, rename } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
import { refreshSnapshot } from './sources.mjs';
import { createIndex, indexStatus } from './rank.mjs';

const file = new URL('./snapshot.json', import.meta.url);
setDefaultResultOrder('ipv4first');
let previous;
try { previous = JSON.parse(await readFile(file, 'utf8')); } catch {}
const snapshot = await refreshSnapshot(fetch, previous);
await writeFile(new URL('./snapshot.json.tmp', import.meta.url), JSON.stringify(snapshot));
await rename(new URL('./snapshot.json.tmp', import.meta.url), file);
const { models, benchmarks, benchmarksWithResults, measurements, checkedAt } = indexStatus(createIndex(snapshot));
console.log(JSON.stringify({ models, benchmarks, benchmarksWithResults, measurements, checkedAt }, null, 2));
