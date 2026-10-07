import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTerminal } from "./build-terminal.mjs";

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
  chmodSync(join(root, "dist/terminal/src/cli.mjs"), 0o755);
}
process.exit(result.status ?? 1);
