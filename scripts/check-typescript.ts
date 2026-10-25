// TypeScript migration ratchet. See docs/typescript-migration.md.
//
// - No new first-party JavaScript: every .js/.mjs/.cjs/.jsx file must already
//   be listed in typescript-ratchet.json, and converted files must leave it.
// - `@ts-ignore` and `@ts-nocheck` are never allowed.
// - Explicit `any` and `@ts-expect-error` counts can only go down.
//
// `--update` rewrites the baseline after a conversion; it refuses to record
// an increase.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

interface Baseline {
  readonly explicitAny: number;
  readonly tsExpectError: number;
  readonly javascript: readonly string[];
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(root, "scripts", "typescript-ratchet.json");
const update = process.argv.includes("--update");

// Tracked files plus new files that are not ignored, so a check before commit sees them.
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter((file) => file && existsSync(join(root, file))).sort();

const javascript = files.filter((file) => /\.(?:m?js|cjs|jsx)$/.test(file));
// Generated binding types are owned by Wrangler, not by us.
const typescript = files.filter((file) => /\.(?:m?ts|cts|tsx)$/.test(file) && !file.startsWith("types/cloudflare/"));

let explicitAny = 0;
let tsExpectError = 0;
const forbidden: string[] = [];
for (const file of typescript) {
  const text = readFileSync(join(root, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) explicitAny += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Compiler directives are comments that start with the directive itself.
  text.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\/\*+|\*)\s*@ts-(?:ignore|nocheck)\b/.test(line)) forbidden.push(`${file}:${index + 1}`);
    if (/^\s*(?:\/\/|\/\*+|\*)\s*@ts-expect-error\b/.test(line)) tsExpectError += 1;
  });
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
const allowed = new Set(baseline.javascript);
const present = new Set(javascript);
const added = javascript.filter((file) => !allowed.has(file));
const removed = baseline.javascript.filter((file) => !present.has(file));

const errors: string[] = [];
if (forbidden.length) errors.push(`@ts-ignore/@ts-nocheck is not allowed; use a typed fix or a described @ts-expect-error:\n  ${forbidden.join("\n  ")}`);
if (added.length) errors.push(`New JavaScript files are not allowed; write them in TypeScript:\n  ${added.join("\n  ")}`);
if (explicitAny > baseline.explicitAny) errors.push(`Explicit \`any\` increased from ${baseline.explicitAny} to ${explicitAny}.`);
if (tsExpectError > baseline.tsExpectError) errors.push(`@ts-expect-error increased from ${baseline.tsExpectError} to ${tsExpectError}.`);

if (update && !errors.length) {
  const next: Baseline = { explicitAny, tsExpectError, javascript };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated ${baselinePath}: ${javascript.length} JavaScript files, ${explicitAny} explicit any, ${tsExpectError} @ts-expect-error.`);
  process.exit(0);
}

// Improvements must be recorded so they cannot silently regress later.
if (removed.length) errors.push(`Converted or deleted JavaScript files are still in the baseline; run \`npm run check:typescript -- --update\`:\n  ${removed.join("\n  ")}`);
if (explicitAny < baseline.explicitAny || tsExpectError < baseline.tsExpectError) {
  errors.push(`Suppressions decreased (any ${baseline.explicitAny} → ${explicitAny}, @ts-expect-error ${baseline.tsExpectError} → ${tsExpectError}); run \`npm run check:typescript -- --update\` to lock it in.`);
}

if (errors.length) {
  console.error(errors.join("\n\n"));
  process.exit(1);
}
console.log(`TypeScript ratchet: ${javascript.length} JavaScript files remain; ${explicitAny} explicit any; ${tsExpectError} @ts-expect-error.`);
