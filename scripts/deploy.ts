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
  "playground-claims": { config: "playground/wrangler.jsonc" },
  site: {
    config: "wrangler.jsonc",
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
  requireGreenCI(commit, key === "playground-claims" ? ["verify", "playground"] : ["verify"]);

  const subject = run("git", ["log", "-1", "--format=%s", commit]).trim();
  console.log(`Deploying ${name} from ${worker.config} at ${commit.slice(0, 12)} (${subject}).`);
  if (!dryRun && !flags.includes("--yes")) await confirm(`Deploy ${name} to production?`);
  const before = dryRun && key !== "site" ? undefined : activeDeployment(name);
  if (before) console.log(`Current versions: ${describe(before)}`);

  // keep_assets inherits the last upload, which need not be the live version.
  // Check after confirmation so a human pause cannot stale these checks.
  if (key === "site") {
    const latest = json<{ id: string; number: number }[]>(wrangler(["versions", "list", "--name", name, "--json"]))
      .sort((a, b) => b.number - a.number)[0];
    const active = before?.versions[0];
    // Version 146 retained 145's assets: the executed upload and receipt prove
    // keep_assets:true with no assets.jwt and 145 both latest and fully active.
    // Evidence and limitations: docs/site-memo.md. No other upload is exempt.
    const verifiedRetention = active?.version_id === "9b0ea195-8c33-40b0-a5ee-a21f3e31a46d"
      && latest?.id === "f6c5d9ae-107a-49e9-883a-5046e57d810c";
    if (before?.versions.length !== 1 || active?.percentage !== 100 || !latest || (active.version_id !== latest.id && !verifiedRetention)) {
      fail("The site has an undeployed upload or split deployment. Reconcile its asset bundle before a keep_assets release; do not deploy an intermediate version just to pass this check.");
    }
  }

  const args = ["deploy", "--config", worker.config, "--strict", "--tag", commit.slice(0, 12), "--message", `${commit.slice(0, 12)} ${subject}`.slice(0, 100)];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(key === "playground-claims" ? join(root, "playground/node_modules/.bin/wrangler") : "wrangler", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`wrangler deploy exited with ${result.status}.`);
  if (dryRun) return;

  const after = activeDeployment(name) ?? fail(`${name} has no active deployment after the upload.`);
  const previous = before?.versions[0]?.version_id;
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
    if (!deployment) {
      console.log(`${key} (${name}, ${worker.config})\n  not deployed yet`);
      continue;
    }
    const lines = deployment.versions.map(({ version_id, percentage }) => {
      const version = json<Version>(wrangler(["versions", "view", version_id, "--name", name, "--json"]));
      const tag = version.annotations?.["workers/tag"];
      return `  ${percentage}% ${version_id} ${tag ? relation(tag) : "untagged (deployed outside scripts/deploy.ts)"}`;
    });
    console.log(`${key} (${name}, ${worker.config})${worker.blocked ? " [deploy blocked]" : ""}\n  deployed ${deployment.created_on}\n${lines.join("\n")}`);
  }
}

function requireGreenCI(commit: string, required: readonly string[]): void {
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const runs = json<{ check_runs: readonly { name: string; status: string; conclusion: string | null }[] }>(
    run("gh", ["api", `repos/${repository}/commits/${commit}/check-runs?per_page=100`]),
  ).check_runs;
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

/** The live deployment, or undefined for a Worker that was never deployed. */
function activeDeployment(name: string): Deployment | undefined {
  const result = spawnSync("wrangler", ["deployments", "status", "--name", name, "--json"], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  // Cloudflare API code 10007: the Worker does not exist on the account.
  if (result.status !== 0 && `${result.stdout}${result.stderr}`.includes("[code: 10007]")) return undefined;
  if (result.status !== 0) fail(`wrangler deployments status --name ${name} failed:\n${result.stderr || result.stdout}`);
  return json<Deployment>(result.stdout);
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
