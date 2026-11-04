import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTerminal } from "./build-terminal.mjs";
import { build } from "esbuild";
import { rule, skill } from "../packages/terminal/src/install.mjs";
import { updateContract } from "../packages/terminal/src/updates.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(root, "dist"), { recursive: true, force: true });

const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status === 0) {
  await buildTerminal();
  cpSync(join(root, "packages/terminal/src"), join(root, "dist/terminal/src"), { recursive: true });
  cpSync(join(root, "packages/terminal/public"), join(root, "dist/terminal/public"), { recursive: true });
  // The legacy CLI and installer are copied, not compiled. Node cannot strip types
  // in node_modules, so their TypeScript imports must use the emitted modules.
  for (const file of ["cli.mjs", "install.mjs"]) {
    const path = join(root, "dist/terminal/src", file);
    writeFileSync(path, readFileSync(path, "utf8").replace(/(from |import\()'(\.\/[^']+)\.ts'/g, "$1'$2.js'"));
  }
  await build({ entryPoints: [join(root, 'packages/pi/src/index.ts')], outfile: join(root, 'dist/pi/scout-extension.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22' });
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(root, "dist/terminal/scout-update.json"), `${JSON.stringify({ format: 1, contract: updateContract, version, skill, rule })}\n`);
  chmodSync(join(root, "dist/terminal/src/cli.mjs"), 0o755);
}
process.exit(result.status ?? 1);
