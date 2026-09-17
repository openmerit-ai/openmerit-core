import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "dist");
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");

// A clean output directory prevents removed source modules from leaking into the npm artifact.
rmSync(outDir, { recursive: true, force: true });
const result = spawnSync(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
