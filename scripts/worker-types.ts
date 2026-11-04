// Generates or checks the binding types for every Worker configuration.
// Runtime types are not committed yet; they arrive with each Worker's
// TypeScript project (see docs/site-typescript-migration.md).
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

const workers = [
  { config: "wrangler.jsonc", envInterface: "SiteEnv", output: "site.d.ts" },
  { config: "wrangler.domains.jsonc", envInterface: "DomainRouterEnv", output: "domain-router.d.ts" },
  { config: "wrangler.scout-alpha.jsonc", envInterface: "ScoutServingEnv", output: "scout-serving.d.ts" },
  { config: "wrangler.scout.jsonc", envInterface: "ScoutPublisherEnv", output: "scout-publisher.d.ts" },
] as const;

const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
mkdirSync(join(root, "types", "cloudflare"), { recursive: true });
let failed = false;
for (const { config, envInterface, output } of workers) {
  const args = [
    wrangler, "types", `types/cloudflare/${output}`,
    "--config", config, "--env-interface", envInterface, "--include-runtime=false",
    ...(check ? ["--check"] : []),
  ];
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    failed = true;
    console.error(`${config}: binding types are out of date. Run \`npm run types:workers\` and commit the result.`);
  }
}
process.exit(failed ? 1 : 0);
