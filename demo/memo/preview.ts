import { mkdir, writeFile } from 'node:fs/promises';
import { startMemoRuntime } from './local-runtime.ts';

const port = Number(process.env.MEMO_PREVIEW_PORT || 45834);
const directory = new URL('../../.wrangler/memo-preview/', import.meta.url);
await mkdir(directory, { recursive: true });
const { mf } = await startMemoRuntime({
  port, origin: `http://127.0.0.1:${port}`,
  onEmail: async message => { await writeFile(new URL('last-email.json', directory), JSON.stringify(message), { mode: 0o600 }); },
});
console.log(`Local memo preview on port ${port}; no real email is sent.`);
console.log('Simulated email is saved to .wrangler/memo-preview/last-email.json.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await mf.dispose(); process.exit(0); });
