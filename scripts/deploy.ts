// Guarded Cloudflare Worker deployments and a read-only deployment report.
//
//   npm run deploy -- <worker> [--dry-run] [--yes]
//   npm run deploy:status
//
// A deploy requires a clean checkout whose HEAD is on origin/main and passed
// CI. Each version is tagged with its commit, and a receipt records the
// previous version for rollback. Runbook: docs/site-deployment.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

interface Worker {
  readonly config: string;
  /** Why this configuration must not be deployed from main, if it must not. */
  readonly blocked?: string;
}

const workers: Readonly<Record<string, Worker>> = {
  "domain-router": { config: "wrangler.domains.jsonc" },
  "scout-serving": { config: "wrangler.scout-alpha.jsonc" },
  "terminal-preview": { config: "wrangler.terminal.jsonc" },
  "scout-publisher": {
    config: "wrangler.scout.jsonc",
    blocked: "main contains unreleased catalogue collection changes; a publisher release needs isolated collection validation first (docs/site-scout-architecture.md#deployment).",
  },
  site: {
    config: "wrangler.jsonc",
    blocked: "the production memo application is newer than this source; deploying it would replace production with older code (docs/site-domain-migration.md).",
  },
};

interface Deployment {
  readonly id: string;
  readonly created_on: string;
  readonly versions: readonly { readonly version_id: string; readonly percentage: number }[];
}

interface Version {
  readonly id: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

// Operate on the checkout the command runs in.
const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || fail("Run this inside the repository.");
const [command, ...rest] = process.argv.slice(2);

if (command === "status") await status();
else if (command && command in workers) await deploy(command, rest);
else fail(`Usage: npm run deploy -- <${Object.keys(workers).join("|")}> [--dry-run] [--yes]\n       npm run deploy:status`);

async function deploy(key: string, flags: readonly string[]): Promise<void> {
  const worker = workers[key];
  if (!worker) fail(`Unknown worker ${key}.`);
  const unknown = flags.filter((flag) => flag !== "--dry-run" && flag !== "--yes");
  if (unknown.length) fail(`Unknown option ${unknown.join(" ")}.`);
  const dryRun = flags.includes("--dry-run");
  if (worker.blocked) fail(`Refusing to deploy ${worker.config}: ${worker.blocked}`);
  const name = workerName(worker.config);

  if (run("git", ["status", "--porcelain"]).trim()) fail("The checkout has uncommitted or untracked files. Deploy only committed code.");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  if (!succeeds("git", ["merge-base", "--is-ancestor", commit, "origin/main"])) fail(`HEAD ${commit.slice(0, 12)} is not on origin/main. Merge the change before deploying it.`);
  requireGreenCI(commit);

  const subject = run("git", ["log", "-1", "--format=%s", commit]).trim();
  const before = dryRun ? undefined : activeDeployment(name);
  console.log(`Deploying ${name} from ${worker.config} at ${commit.slice(0, 12)} (${subject}).`);
  if (before) console.log(`Current versions: ${describe(before)}`);
  if (!dryRun && !flags.includes("--yes")) await confirm(`Deploy ${name} to production?`);

  const args = ["deploy", "--config", worker.config, "--strict", "--tag", commit.slice(0, 12), "--message", `${commit.slice(0, 12)} ${subject}`.slice(0, 100)];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync("wrangler", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`wrangler deploy exited with ${result.status}.`);
  if (dryRun || !before) return;

  const after = activeDeployment(name);
  const previous = before.versions[0]?.version_id;
  const receipt = {
    worker: name, config: worker.config, commit, subject, deployedAt: new Date().toISOString(),
    before, after,
    rollback: previous ? `npx wrangler rollback ${previous} --name ${name} --message "Roll back ${commit.slice(0, 12)}"` : undefined,
  };
  const directory = join(root, ".deploys", key);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${receipt.deployedAt.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Active versions: ${describe(after)}\nReceipt: ${file}`);
  if (receipt.rollback) console.log(`Rollback: ${receipt.rollback}`);
}

async function status(): Promise<void> {
  run("git", ["fetch", "--quiet", "origin", "main"]);
  for (const [key, worker] of Object.entries(workers)) {
    const name = workerName(worker.config);
    const deployment = activeDeployment(name);
    const lines = deployment.versions.map(({ version_id, percentage }) => {
      const version = json<Version>(wrangler(["versions", "view", version_id, "--name", name, "--json"]));
      const tag = version.annotations?.["workers/tag"];
      return `  ${percentage}% ${version_id} ${tag ? relation(tag) : "untagged (deployed outside scripts/deploy.ts)"}`;
    });
    console.log(`${key} (${name}, ${worker.config})${worker.blocked ? " [deploy blocked]" : ""}\n  deployed ${deployment.created_on}\n${lines.join("\n")}`);
  }
  // The publisher's health is visible only through the serving catalogue.
  const response = await fetch("https://openmerit.ai/scout/api/status", { headers: { "user-agent": "openmerit-deploy-status" } });
  const catalogue = response.ok ? (await response.json()) as Readonly<Record<string, unknown>> : undefined;
  if (!catalogue) {
    console.log(`\nScout catalogue: status request failed with HTTP ${response.status}.`);
    return;
  }
  const healthy = catalogue["refreshStatus"] !== "failed" && catalogue["stale"] !== true;
  console.log(`\nScout catalogue${healthy ? "" : " [WARNING]"}: refresh ${String(catalogue["refreshStatus"])}, stale ${String(catalogue["stale"])}, last attempt ${String(catalogue["lastAttemptAt"])}, snapshot ${String(catalogue["snapshotVersion"])}`);
  if (typeof catalogue["refreshError"] === "string") console.log(`  ${catalogue["refreshError"]}`);
}

function requireGreenCI(commit: string): void {
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const runs = json<{ check_runs: readonly { name: string; status: string; conclusion: string | null }[] }>(
    run("gh", ["api", `repos/${repository}/commits/${commit}/check-runs?per_page=100`]),
  ).check_runs;
  const required = ["verify", "package-smoke"];
  const missing = required.filter((name) => !runs.some((check) => check.name === name));
  const failing = runs.filter((check) => check.status !== "completed" || !["success", "skipped", "neutral"].includes(check.conclusion ?? ""));
  if (missing.length || failing.length) {
    fail(`CI has not passed for ${commit.slice(0, 12)}: ${[...missing.map((name) => `${name} missing`), ...failing.map((check) => `${check.name} ${check.conclusion ?? check.status}`)].join(", ")}.`);
  }
}

function relation(tag: string): string {
  if (!succeeds("git", ["cat-file", "-e", `${tag}^{commit}`])) return `tag ${tag} (commit not found locally)`;
  if (!succeeds("git", ["merge-base", "--is-ancestor", tag, "origin/main"])) return `tag ${tag} (not on origin/main)`;
  const behind = Number(run("git", ["rev-list", "--count", `${tag}..origin/main`]).trim());
  return `tag ${tag} (${behind ? `${behind} commits behind origin/main` : "at origin/main"})`;
}

function activeDeployment(name: string): Deployment {
  return json<Deployment>(wrangler(["deployments", "status", "--name", name, "--json"]));
}

function describe(deployment: Deployment): string {
  return deployment.versions.map(({ version_id, percentage }) => `${version_id} (${percentage}%)`).join(", ");
}

function workerName(config: string): string {
  // Every configuration declares its top-level name first.
  const name = /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(join(root, config), "utf8"))?.[1];
  if (!name) fail(`${config} has no Worker name.`);
  return name;
}

async function confirm(question: string): Promise<void> {
  if (!process.stdin.isTTY) fail("Confirmation needs an interactive terminal; pass --yes only after the owner approved this deploy.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} Type "deploy" to continue: `);
  prompt.close();
  if (answer.trim() !== "deploy") fail("Cancelled.");
}

function wrangler(args: readonly string[]): string {
  return run("wrangler", args);
}

function json<T>(text: string): T {
  // Wrangler can print banners before JSON output.
  const start = text.search(/^[[{]/m);
  return JSON.parse(start === -1 ? text : text.slice(start)) as T;
}

function run(file: string, args: readonly string[]): string {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${file} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function succeeds(file: string, args: readonly string[]): boolean {
  return spawnSync(file, args, { cwd: root, stdio: "ignore" }).status === 0;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
