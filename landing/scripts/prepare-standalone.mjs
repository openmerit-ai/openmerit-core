import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const standaloneDirectory = existsSync('.next/standalone/landing/server.js') ? '.next/standalone/landing' : '.next/standalone';

if (!existsSync(standaloneDirectory)) {
  throw new Error('Next.js standalone output was not generated.');
}

mkdirSync(join(standaloneDirectory, '.next'), { recursive: true });
cpSync('public', join(standaloneDirectory, 'public'), { recursive: true });
cpSync('.next/static', join(standaloneDirectory, '.next/static'), {
  recursive: true,
});
