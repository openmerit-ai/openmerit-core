// Guarded deploys of the cloud app to its Rivet Cloud cluster, with the same rules as the
// repository's scripts/deploy.ts: committed code on origin/main, green CI, and a receipt with the
// rollback command. Runbook: cloud/README.md.
//
//   npm run deploy -- [--dry-run] [--yes]      build cloud/Dockerfile and roll the pool onto it
//   npm run deploy -- --build <id> [--yes]     roll back (or forward) to an uploaded build
//   npm run deploy -- secrets [--yes]          copy the app's secrets from this environment to the cluster
//   npm run deploy -- status                   read-only: receipts and what the origin answers
//
// RIVET_CLOUD_TOKEN (a rivet_cluster_… cluster token, or a cloud_api_… token with RIVET_ORG)
// authenticates the Rivet CLI, which reads it from the environment. RIVET_CLUSTER is the cluster's
// name, not its slug; the origin is on the slug.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const CLUSTER = process.env.RIVET_CLUSTER ?? "openmerit";
const ORIGIN = (process.env.RIVET_ORIGIN ?? "https://openmeritdr2i.onrivet.dev").replace(/\/$/, "");
/**
 * CI jobs a commit needs before it is deployed. Other jobs, such as the npm package's macOS runs,
 * must not have failed, but one still queued, running or cancelled does not hold up the cloud app.
 */
const REQUIRED_CHECKS = ["verify", "cloud"];
/** Cluster secrets the pool reads, each set from the variable of the same name. The pool reads only those set on the cluster. */
const SECRETS = ["CLERK_SECRET_KEY", "OPENROUTER_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "OPENMERIT_KEY_ENCRYPTION_KEY"];
/** Plain pool variables, from this environment when set. */
const SETTINGS = ["CLERK_PUBLISHABLE_KEY", "STRIPE_PRICE_ID", "STRIPE_METER_EVENT", "OPENMERIT_PUBLIC_URL", "OPENMERIT_APP_URL", "OPENMERIT_CASE_WRITER_MODEL", "OPENMERIT_JUDGE_MODEL"];

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim() || fail("Run this inside the repository.");
const rivet = join(root, "cloud", "node_modules", ".bin", "rivet");
const receipts = join(root, ".deploys", "cloud");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fail(`${name} needs a value.`) : undefined; };

if (args[0] === "status") await status();
else if (args[0] === "secrets") await secrets();
else await deploy();

async function deploy(): Promise<void> {
  const known = new Set(["--dry-run", "--yes", "--build", value("--build")]);
  const unknown = args.filter(arg => !known.has(arg));
  if (unknown.length) fail(`Unknown option ${unknown.join(" ")}.`);
  const dryRun = flag("--dry-run"), build = value("--build");
  if (run("git", ["status", "--porcelain"]).trim()) fail("The checkout has uncommitted or untracked files. Deploy only committed code.");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  if (!succeeds("git", ["merge-base", "--is-ancestor", commit, "origin/main"])) fail(`HEAD ${commit.slice(0, 12)} is not on origin/main. Merge the change before deploying it.`);
  requireGreenCI(commit);
  const subject = run("git", ["log", "-1", "--format=%s", commit]).trim();
  credentials();
  const previous = lastReceipt();
  console.log(build ? `Rolling ${CLUSTER} onto build ${build}.` : `Deploying the cloud app to ${CLUSTER} at ${commit.slice(0, 12)} (${subject}).`);
  if (previous) console.log(`Current build: ${previous.build ?? "unknown"} from ${previous.commit.slice(0, 12)}.`);
  if (dryRun) {
    console.log(`Would run: rivet ${deployArgs(commit, build).join(" ")}`);
    return;
  }
  if (!flag("--yes")) await confirm(`Deploy to ${CLUSTER}?`);
  const result = spawnSync(rivet, deployArgs(commit, build), { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  if (result.status !== 0) fail(`rivet deploy exited with ${result.status}.`);
  const deployed = build ?? /\b(?:build(?:\s+id)?[:\s]+)([\w-]{8,})/i.exec(result.stdout)?.[1] ?? null;
  const health = await answers();
  const receipt = {
    cluster: CLUSTER, origin: ORIGIN, commit, subject, build: deployed, deployedAt: new Date().toISOString(), previous: previous ? { build: previous.build, commit: previous.commit } : null, health,
    rollback: previous?.build ? `npm run deploy --prefix cloud -- --build ${previous.build}` : undefined,
  };
  mkdirSync(receipts, { recursive: true });
  const file = join(receipts, `${receipt.deployedAt.replaceAll(":", "-")}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Build: ${deployed ?? "see the output above"}\n${health}\nReceipt: ${file}`);
  if (receipt.rollback) console.log(`Rollback: ${receipt.rollback}`);
}

function deployArgs(commit: string, build: string | undefined): string[] {
  const settings = SETTINGS.filter(name => process.env[name]).flatMap(name => ["--env", `${name}=${process.env[name]}`]);
  // A secret not yet on the cluster, such as the Stripe webhook secret before the webhook exists, is left out: the app runs without that feature.
  const onCluster = clusterSecrets();
  const secrets = SECRETS.filter(name => onCluster.has(name));
  return [
    "deploy", "--cluster", CLUSTER, ...(process.env.RIVET_ORG ? ["--org", process.env.RIVET_ORG] : []), "--yes",
    ...(build ? ["--build", build] : ["--dockerfile", "cloud/Dockerfile", "--build-context", ".", "--image", "openmerit-cloud", "--tag", commit.slice(0, 12)]),
    // One node: actors live on the cluster, so more nodes add capacity, not state.
    "--min-scale", "1", "--memory", "1Gi",
    ...secrets.flatMap(name => ["--secret", name]), ...settings,
  ];
}

function clusterSecrets(): Set<string> {
  const listed = JSON.parse(run(rivet, ["cluster", "secret", "list", "--cluster", CLUSTER, "--json", ...(process.env.RIVET_ORG ? ["--org", process.env.RIVET_ORG] : [])])) as ({ name?: string } | string)[];
  return new Set(listed.map(item => (typeof item === "string" ? item : item.name ?? "")));
}

/**
 * Copies each secret set in this environment to the cluster, by name; values pass through the CLI's
 * --from-env, never argv. Secrets not set here are left as they are on the cluster.
 */
async function secrets(): Promise<void> {
  credentials();
  const present = SECRETS.filter(name => process.env[name]);
  const missing = SECRETS.filter(name => !process.env[name]);
  if (!present.length) fail(`None of ${SECRETS.join(", ")} is set in this environment.`);
  if (missing.length) console.log(`Not set in this environment, so left as they are on the cluster: ${missing.join(", ")}.`);
  if (!flag("--yes")) await confirm(`Set ${present.length} secrets on ${CLUSTER}?`);
  for (const name of present) {
    const result = spawnSync(rivet, ["cluster", "secret", "set", name, "--from-env", name, "--cluster", CLUSTER, ...(process.env.RIVET_ORG ? ["--org", process.env.RIVET_ORG] : []), "--yes"], { cwd: root, stdio: "inherit" });
    if (result.status !== 0) fail(`Setting ${name} failed.`);
  }
  console.log(`Set ${present.join(", ")} on ${CLUSTER}.`);
}

async function status(): Promise<void> {
  const previous = lastReceipt();
  console.log(previous ? `Last deploy from this checkout: build ${previous.build ?? "unknown"} at ${previous.commit.slice(0, 12)}, ${previous.deployedAt}.` : "No deploy receipts in this checkout.");
  console.log(await answers());
}

/** What the origin answers on the paths the router sends it. */
async function answers(): Promise<string> {
  const lines: string[] = [];
  for (const path of ["/health", "/.well-known/oauth-protected-resource", "/mcp"]) {
    try {
      const response = await fetch(`${ORIGIN}${path}`, { method: path === "/mcp" ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(path === "/mcp" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) } : {}), signal: AbortSignal.timeout(15_000) });
      lines.push(`${path === "/mcp" ? "POST" : "GET"} ${ORIGIN}${path}: ${response.status}`);
    } catch (error) { lines.push(`${ORIGIN}${path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return lines.join("\n");
}

interface Receipt { commit: string; build: string | null; deployedAt: string }
function lastReceipt(): Receipt | null {
  try {
    const latest = readdirSync(receipts).filter(name => name.endsWith(".json")).sort().at(-1);
    return latest ? JSON.parse(readFileSync(join(receipts, latest), "utf8")) as Receipt : null;
  } catch { return null; }
}

function credentials(): void {
  if (!process.env.RIVET_CLOUD_TOKEN) fail("Set RIVET_CLOUD_TOKEN to the cluster's token (rivet_cluster_…). The engine's admin token does not reach the Cloud API.");
  try { readFileSync(rivet); } catch { fail("Run npm ci in cloud/ first: the deploy uses its pinned Rivet CLI."); }
}

function requireGreenCI(commit: string): void {
  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const runs = (JSON.parse(run("gh", ["api", `repos/${repository}/commits/${commit}/check-runs?per_page=100`])) as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs;
  const missing = REQUIRED_CHECKS.filter(name => !runs.some(check => check.name === name));
  const passed = (check: { status: string; conclusion: string | null }) => check.status === "completed" && ["success", "skipped", "neutral"].includes(check.conclusion ?? "");
  // Another job blocks only when it failed: one still queued or cancelled, such as a macOS run that found no runner, did not test the cloud app.
  const unfinished = (check: { status: string; conclusion: string | null }) => check.status !== "completed" || check.conclusion === "cancelled";
  const failing = runs.filter(check => (REQUIRED_CHECKS.includes(check.name) || !unfinished(check)) && !passed(check));
  const pending = runs.filter(check => !REQUIRED_CHECKS.includes(check.name) && unfinished(check));
  if (pending.length) console.log(`Not waiting for ${pending.map(check => `${check.name} (${check.conclusion ?? check.status})`).join(", ")}: the cloud app needs only ${REQUIRED_CHECKS.join(" and ")}.`);
  if (missing.length || failing.length) fail(`CI has not passed for ${commit.slice(0, 12)}: ${[...missing.map(name => `${name} missing`), ...failing.map(check => `${check.name} ${check.conclusion ?? check.status}`)].join(", ")}.`);
}

async function confirm(question: string): Promise<void> {
  if (!process.stdin.isTTY) fail("Confirmation needs an interactive terminal; pass --yes only after the owner approved this deploy.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} Type "deploy" to continue: `);
  prompt.close();
  if (answer.trim() !== "deploy") fail("Cancelled.");
}

function run(file: string, argv: readonly string[]): string {
  const result = spawnSync(file, argv, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${file} ${argv.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function succeeds(file: string, argv: readonly string[]): boolean { return spawnSync(file, argv, { cwd: root, stdio: "ignore" }).status === 0; }

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
