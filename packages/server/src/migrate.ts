import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
if(!process.env.DATABASE_URL)throw Error('Set DATABASE_URL');
const sql=postgres(process.env.DATABASE_URL);
await sql.unsafe(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
await sql.end();
console.log('Migrations applied');
