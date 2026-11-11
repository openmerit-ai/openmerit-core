// After `tsc -p tsconfig.build.json`: tsc's rewriteRelativeImportExtensions rewrites `./x.ts` to `./x.js`
// in emitted JavaScript but not in declarations, so rewrite relative specifiers in dist/**/*.d.ts too.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const specifier = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+)\.ts\2/g;
let rewritten = 0;
for (const entry of await readdir(dist, { recursive: true })) {
  if (!entry.endsWith(".d.ts")) continue;
  const file = join(dist, entry);
  const source = await readFile(file, "utf8");
  const output = source.replace(specifier, (_, prefix: string, quote: string, path: string) => `${prefix}${quote}${path}.js${quote}`);
  if (output !== source) { await writeFile(file, output); rewritten++; }
}
process.stdout.write(`Rewrote .ts import paths in ${rewritten} declaration files\n`);
