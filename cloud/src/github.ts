// GitHub repositories an account adds for review. It parses what the user pasted, checks access
// with GitHub's free REST API, shallow-clones the default branch into a temporary sandbox directory,
// reviews the checkout and deletes it. Read-only: OpenMerit sends GitHub only GET requests and git's
// fetch, and never pushes, opens a pull request or writes to a repository. Nothing in a checkout runs:
// git runs no hooks, checks symlinks out as plain files and gets no secret in its environment.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalogue } from "./engine.ts";
import { createHarness, type Harness } from "../../openmerit-core/src/harness/harness.ts";
import { reviewRepo } from "../../openmerit-core/src/review/index.ts";
import { isSupportFile, scanRepo, type ScanResult } from "../../openmerit-core/src/scout/scan.ts";
import type { Case, TaskBundle } from "../../openmerit-core/src/ranking/index.ts";
import { bundleProblem, redactBundle } from "./start.ts";

/** openmerit-core's MANAGED_NOTE (eval/generated.ts): the note beside an eval copy app.openmerit.ai owns. */
const MANAGED_NOTE = "MANAGED.md";

export interface GitHubConfig {
  /** GitHub's REST API, https://api.github.com. Tests point it at a fake. */
  apiUrl: string;
  /** Where repositories are cloned from, https://github.com. Tests point it at a fake. */
  gitUrl: string;
  /** Largest repository OpenMerit clones, by GitHub's reported size and on disk while cloning. */
  maxBytes: number;
  /** Longest a clone may take. */
  cloneTimeoutMs: number;
  /** The OpenMerit GitHub App's slug (github.com/apps/<slug>), whose installations let a user signed in with GitHub pick repositories; null hides that way of adding one. */
  appSlug: string | null;
}

export interface RepoRef { owner: string; name: string }

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The repository a pasted GitHub URL names: https://github.com/owner/repo, with or without the scheme,
 * a `.git` suffix or a path after it such as /tree/main, or git@github.com:owner/repo.git. Null otherwise.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  const value = input.trim();
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
  let parts: string[];
  if (ssh) parts = [ssh[1]!, ssh[2]!];
  else {
    let url: URL;
    try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch { return null; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") return null;
    if (url.username || url.password || url.port) return null;
    parts = url.pathname.split("/").filter(Boolean).slice(0, 2);
    if (parts[1]) parts[1] = parts[1].replace(/\.git$/i, "");
  }
  const [owner, name] = parts;
  if (!owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

/** Why a token is refused before GitHub sees it, or null. Only fine-grained tokens, which a user limits to some repositories and to reading. */
export function tokenProblem(token: string): string | null {
  if (/^ghp_/.test(token)) return "This is a classic token, which can write to every repository you can. Create a fine-grained token instead, with Contents: Read-only on only the repositories OpenMerit reviews.";
  if (!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(token)) return "This is not a GitHub fine-grained token: those start with github_pat_.";
  return null;
}

export interface CheckedRepo { fullName: string; private: boolean; defaultBranch: string; sizeKb: number }

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;

/**
 * Checks that OpenMerit can read the repository, with free REST calls: the repository's metadata and,
 * with a token, its latest commit, which needs the token's Contents permission. Refuses a repository
 * larger than the clone limit.
 */
export async function checkRepo(ref: RepoRef, token: string | null, config: GitHubConfig, fetcher: typeof fetch = fetch): Promise<{ ok: true; repo: CheckedRepo } | { ok: false; error: string }> {
  const slug = `${ref.owner}/${ref.name}`;
  const get = async (path: string) => {
    try {
      return await fetcher(`${config.apiUrl}${path}`, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "OpenMerit", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
    } catch { return null; }
  };
  const refused = async (response: Response | null): Promise<string | null> => {
    if (!response) return "GitHub could not be reached. Try again in a moment.";
    if (response.status === 401) return "GitHub refused this token: it may have expired or been revoked.";
    // GitHub's limit: 60 checks an hour per address without a token, more per token. It answers 403 or 429,
    // with the time the limit resets in x-ratelimit-reset (Unix seconds) or, for a 429, retry-after (seconds).
    if ((response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") || response.status === 429) {
      await response.body?.cancel();
      const reset = Number(response.headers.get("x-ratelimit-reset")), retry = Number(response.headers.get("retry-after"));
      const at = reset > 0 ? reset * 1000 : retry > 0 ? Date.now() + retry * 1000 : null;
      const after = at ? `after ${new Date(at).toISOString().slice(11, 16)} UTC` : "in an hour";
      return `${token ? "GitHub's limit for this token's checks" : "GitHub's limit for checks without a token"} is used up; try again ${after}.`;
    }
    return null;
  };
  const meta = await get(`/repos/${ref.owner}/${ref.name}`);
  const metaRefusal = await refused(meta);
  if (metaRefusal) return { ok: false, error: metaRefusal };
  if (meta!.status === 404) return { ok: false, error: token ? `This token cannot see ${slug}. Check that its Repository access includes it.` : `GitHub has no public repository ${slug}. If it is private, add it with a fine-grained token that can read it.` };
  if (!meta!.ok) return { ok: false, error: `GitHub answered ${meta!.status} for ${slug}.` };
  const data = await meta!.json() as { full_name?: unknown; private?: unknown; default_branch?: unknown; size?: unknown };
  if (typeof data.full_name !== "string" || typeof data.default_branch !== "string") return { ok: false, error: `GitHub's answer for ${slug} had no default branch.` };
  const sizeKb = typeof data.size === "number" ? data.size : 0;
  if (sizeKb * 1024 > config.maxBytes) return { ok: false, error: `${data.full_name} is ${mb(sizeKb * 1024)} on GitHub, more than the ${mb(config.maxBytes)} OpenMerit reviews.` };
  if (token) {
    const commits = await get(`/repos/${ref.owner}/${ref.name}/commits?per_page=1`);
    const commitsRefusal = await refused(commits);
    if (commitsRefusal) return { ok: false, error: commitsRefusal };
    if (commits!.status === 409) return { ok: false, error: `${data.full_name} has no commits yet.` };
    if (commits!.status === 403 || commits!.status === 404) return { ok: false, error: `This token can see ${data.full_name} but not read its code. Give it Contents: Read-only.` };
    if (!commits!.ok) return { ok: false, error: `GitHub answered ${commits!.status} for ${data.full_name}'s commits.` };
    await commits!.body?.cancel();
  }
  return { ok: true, repo: { fullName: data.full_name, private: data.private === true, defaultBranch: data.default_branch, sizeKb } };
}

/** An installation of the OpenMerit GitHub App that the signed-in user can reach, and the repositories it gives OpenMerit. */
export interface AppInstallation { id: number; account: string; type: string; selection: "all" | "selected"; manageUrl: string; repos: CheckedRepo[] }

/**
 * The repositories the user's GitHub token reaches through installations of the OpenMerit GitHub App:
 * GET /user/installations, then each one's repositories, 100 a page. GitHub lists only this app's
 * installations for its user tokens. Null with the reason when GitHub refuses the token.
 */
export async function appInstallations(token: string, config: GitHubConfig, fetcher: typeof fetch = fetch): Promise<{ ok: true; installations: AppInstallation[] } | { ok: false; error: string }> {
  const get = async (path: string) => {
    let response: Response;
    try {
      response = await fetcher(`${config.apiUrl}${path}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "OpenMerit", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    } catch { return { error: "GitHub could not be reached. Try again in a moment." } as const; }
    if (response.status === 401) return { error: "GitHub refused your GitHub sign-in's token. Sign out and sign in with GitHub again." } as const;
    if (!response.ok) { await response.body?.cancel(); return { error: `GitHub answered ${response.status} for ${path.split("?")[0]}.` } as const; }
    return { data: await response.json() as Record<string, unknown> } as const;
  };
  const listed = await get("/user/installations?per_page=100");
  if ("error" in listed) return { ok: false, error: listed.error };
  const installations: AppInstallation[] = [];
  for (const item of (listed.data.installations ?? []) as { id: number; account?: { login?: string; type?: string }; repository_selection?: string; html_url?: string }[]) {
    const repos: CheckedRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const found = await get(`/user/installations/${item.id}/repositories?per_page=100&page=${page}`);
      if ("error" in found) return { ok: false, error: found.error };
      const batch = (found.data.repositories ?? []) as { full_name: string; private?: boolean; default_branch?: string; size?: number }[];
      repos.push(...batch.map(repo => ({ fullName: repo.full_name, private: repo.private === true, defaultBranch: repo.default_branch ?? "main", sizeKb: repo.size ?? 0 })));
      if (batch.length < 100) break;
    }
    installations.push({ id: item.id, account: item.account?.login ?? "", type: item.account?.type ?? "User", selection: item.repository_selection === "all" ? "all" : "selected",
      manageUrl: item.html_url ?? `https://github.com/settings/installations/${item.id}`, repos });
  }
  return { ok: true, installations };
}

/** Bytes under a directory, without following symlinks. */
async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(path);
    else total += (await lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Runs git with only the environment it needs: no secret of the app's reaches it, and no user or system config. */
function git(args: string[], options: { cwd: string; home: string; token?: string | null; timeoutMs: number; watch?: () => Promise<string | null> }): Promise<string> {
  const header = options.token ? [["http.extraHeader", `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`]] : [];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: options.home, LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_LFS_SKIP_SMUDGE: "1",
    // The token goes in an environment-only config entry: not on the command line, in the remote URL or in .git/config.
    GIT_CONFIG_COUNT: String(header.length), ...Object.fromEntries(header.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key!], [`GIT_CONFIG_VALUE_${index}`, value!]])),
  };
  return new Promise((resolve, reject) => {
    // Its own process group, so stopping it also stops git-remote-https, which does the download.
    const child = spawn("git", args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", stopped: string | null = null;
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err = (err + chunk).slice(-4000); });
    const stop = (why: string) => {
      if (stopped) return;
      stopped = why;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => stop(`took longer than ${Math.round(options.timeoutMs / 1000)} s`), options.timeoutMs);
    let checking = false;
    const poll = options.watch ? setInterval(() => {
      if (checking) return;
      checking = true;
      void options.watch!().then(problem => { checking = false; if (problem) stop(problem); });
    }, 500) : null;
    child.once("error", error => { clearTimeout(timer); if (poll) clearInterval(poll); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (stopped) reject(new Error(stopped));
      else if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").filter(line => !/^(Cloning into|warning:)/.test(line)).at(-1)?.replace(/^fatal:\s*/, "") || `git exited with ${code}`));
    });
  });
}

/** Clones run one or two at a time on a node, which has one small disk and two CPUs. */
const MAX_CLONES = 2;
let cloning = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (cloning >= MAX_CLONES) await new Promise<void>(resolve => waiting.push(resolve));
  cloning += 1;
  try { return await work(); } finally { cloning -= 1; waiting.shift()?.(); }
}

export interface Checkout { root: string; commit: string; bytes: number }

/**
 * A shallow clone of one branch into a new temporary directory, without its history, tags, submodules,
 * LFS objects or hooks, and with symlinks as plain files, so reading the checkout never leaves it.
 * Stops at the size and time limits. The .git directory is deleted once the commit is read, so nothing
 * runs git on the checkout again. `use` gets the checkout; the directory is deleted when it returns or throws.
 */
export async function withCheckout<T>(input: { fullName: string; branch: string; token: string | null; config: GitHubConfig }, use: (checkout: Checkout) => Promise<T>): Promise<T> {
  return slot(async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "openmerit-repo-"));
    try {
      const home = join(sandbox, "home"), root = join(sandbox, "repo");
      await mkdir(home);
      const { config } = input;
      const http = config.gitUrl.startsWith("http://") ? ["-c", "protocol.http.allow=always"] : [];
      const tooBig = async () => (await bytesUnder(sandbox)) > config.maxBytes ? `grew past ${mb(config.maxBytes)}` : null;
      try {
        await git(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...http, "-c", "core.symlinks=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false",
          "clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", input.branch, "--", `${config.gitUrl}/${input.fullName}.git`, root],
        { cwd: sandbox, home, token: input.token, timeoutMs: config.cloneTimeoutMs, watch: tooBig });
        // The watch looks twice a second; a clone can finish in between.
        const problem = await tooBig();
        if (problem) throw new Error(problem);
      } catch (error) {
        throw new Error(`Cloning ${input.fullName} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const commit = (await git(["rev-parse", "HEAD"], { cwd: root, home, timeoutMs: 10_000 })).trim();
      await rm(join(root, ".git"), { recursive: true, force: true });
      return await use({ root, commit, bytes: await bytesUnder(root) });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
}

/** A model call the review found: where it is and the model it names, or the expression that picks it. No source line is kept. */
export interface ModelCall { file: string; line: number; value: string; catalogueId: string | null; dynamic: boolean; envVar: string | null }

export interface RepoReview {
  /** `review` when openmerit-core's reviewRepo wrote the task specs; `scan` when the app has no reviewer key and only lists the model calls. */
  reviewer: "scan" | "review";
  commit: string;
  branch: string;
  files: number;
  bytes: number;
  /** The models the code names, the application's own code first, with how many calls name each. */
  models: { value: string; catalogueId: string | null; calls: number }[];
  /** At most MAX_CALLS of the application's model calls, in the order the scan found them. */
  modelCalls: ModelCall[];
  /** Every model call in the application's code, including those past MAX_CALLS. Examples, scripts and demos count as the application. */
  totalCalls: number;
  /** Model calls in tests, specs, mocks, fixtures, recorded responses, snapshots, docs and saved results (openmerit-core's `isSupportFile`): counted, never listed or reviewed. */
  supportCalls: number;
  /** \`${supportCalls} more in tests, fixtures or docs, not listed\`, or null when there are none. */
  notListed: string | null;
  /** One spec per task the review found, written from the application's code only. */
  tasks: TaskBundle[];
  /** Application model calls the review tied to no spec, and why, such as a task whose review failed. */
  unmapped: { usageIds: string[]; reason: string }[];
  /** What the review's model calls cost on OpenMerit's OpenRouter key, as the account's spend ledger records it. */
  costUsd: number;
  durationMs: number;
}

/** The model that reviews a checkout, on OpenMerit's OpenRouter key, and the most one review may spend and take. */
export interface ReviewerConfig { model: string; apiKey: string; baseUrl: string; budgetUsd: number; timeoutMs: number }

const MAX_CALLS = 200;

/**
 * The scan without usages in tests, fixtures, docs and other support files, which no production task
 * runs, and how many model calls it left out. Its models keep only the usages it kept.
 */
export function applicationScan(scan: ScanResult): { scan: ScanResult; supportCalls: number } {
  const kept = scan.usages.filter(usage => !isSupportFile(usage.file));
  const ids = new Set(kept.map(usage => usage.id));
  const models = scan.models.map(model => ({ ...model, usageIds: model.usageIds.filter(id => ids.has(id)) })).filter(model => model.usageIds.length);
  const supportCalls = scan.usages.filter(usage => usage.kind === "model" && !ids.has(usage.id)).length;
  return { scan: { ...scan, usages: kept, models }, supportCalls };
}

const OPENROUTER_API = "https://openrouter.ai/api/v1";
let agentDir: string | null = null;
/**
 * Pi's agent directory for the reviewer: one per process, since Pi keeps the first one it is given. It
 * holds no credential. Only a test's OpenRouter base URL is written to its models.json: Pi's own entries
 * send each OpenRouter model to the API it speaks there (chat completions or Anthropic's messages).
 */
function reviewerDir(baseUrl: string): string {
  if (!agentDir) {
    agentDir = join(tmpdir(), `openmerit-reviewer-${process.pid}`);
    mkdirSync(agentDir, { recursive: true });
    if (baseUrl !== OPENROUTER_API) writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl } } }));
  }
  return agentDir;
}

/**
 * The review entry point: reads a checkout and returns its task specs, from the application's code
 * only. openmerit-core's `reviewRepo` gets the application-only scan, so no task spec is written from
 * test code; its model reads the checkout only through Pi's read-only tools, inside `root`, and nothing
 * in the checkout runs. Without a reviewer it is the scan alone, which lists the model calls. A review
 * that stops, at its budget, time limit or an error, keeps the listing and says why in `unmapped`.
 */
export async function reviewCheckout(root: string, catalogue: Catalogue, reviewer: ReviewerConfig | null): Promise<{ reviewer: RepoReview["reviewer"]; scan: ScanResult; supportCalls: number; tasks: TaskBundle[]; unmapped: RepoReview["unmapped"]; costUsd: number }> {
  const { scan, supportCalls } = applicationScan(scanRepo(root, catalogue));
  if (!reviewer) return { reviewer: "scan", scan, supportCalls, tasks: [], unmapped: [], costUsd: 0 };
  // Nothing in the application's code to review: no model call is made.
  if (!scan.usages.some(usage => usage.kind === "model")) return { reviewer: "review", scan, supportCalls, tasks: [], unmapped: [], costUsd: 0 };
  const harness = await createHarness({ kind: "api", api: { provider: "openrouter", model: reviewer.model, apiKey: { env: "OPENROUTER_API_KEY" } } },
    { OPENROUTER_API_KEY: reviewer.apiKey, PI_CODING_AGENT_DIR: reviewerDir(reviewer.baseUrl) });
  // The review stops at its budget, checked before each request and as each model call reports its cost, and at its time limit.
  const spent = new AbortController();
  const watch = setInterval(() => { if (harness.usage.costUsd >= reviewer.budgetUsd) spent.abort(); }, 250);
  const signal = AbortSignal.any([spent.signal, AbortSignal.timeout(reviewer.timeoutMs)]);
  const stopped = () => spent.signal.aborted ? `it reached its $${reviewer.budgetUsd.toFixed(2)} budget` : signal.aborted ? `it ran past ${Math.round(reviewer.timeoutMs / 60_000)} minutes` : null;
  // A model whose price Pi does not know bills the whole budget.
  const costUsd = () => harness.usage.unknownCost ? Math.max(harness.usage.costUsd, reviewer.budgetUsd) : harness.usage.costUsd;
  const calls = scan.usages.filter(usage => usage.kind === "model").map(usage => usage.id);
  try {
    const budgeted: Harness = { kind: harness.kind, label: harness.label, usage: harness.usage,
      json: request => { if (harness.usage.costUsd >= reviewer.budgetUsd) spent.abort(); return signal.aborted ? Promise.reject(new Error("stopped")) : harness.json(request); } };
    const reviewed = await reviewRepo({ root, scan, harness: budgeted, signal });
    const why = stopped();
    const unmapped = why ? reviewed.unmapped.map(item => ({ ...item, reason: item.reason.replace(/ failed: [\s\S]*$/, ` stopped: ${why}.`) })) : reviewed.unmapped;
    return { reviewer: "review", scan, supportCalls, tasks: reviewed.tasks, unmapped, costUsd: costUsd() };
  } catch (error) {
    return { reviewer: "review", scan, supportCalls, tasks: [], unmapped: [{ usageIds: calls, reason: `The review stopped: ${stopped() ?? (error instanceof Error ? error.message : String(error))}.` }], costUsd: costUsd() };
  } finally {
    clearInterval(watch);
  }
}

/** An eval Scout wrote in the repository, which the review offers as a draft for the project. */
export interface RepoEval { dir: string; bundle: TaskBundle; cases: Case[] }
const MAX_REPO_EVALS = 50, MAX_EVAL_BYTES = 1024 * 1024;

/**
 * The evals Scout generated in `.openmerit/evals/<task>/` (bundle.json and cases.json), skipping the
 * copies app.openmerit.ai manages, which carry MANAGED.md, and any that is not a usable bundle.
 */
export function repoEvals(root: string): RepoEval[] {
  const base = join(root, ".openmerit", "evals");
  if (!existsSync(base)) return [];
  const found: RepoEval[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || found.length >= MAX_REPO_EVALS) continue;
    const dir = join(base, entry.name), files = ["bundle.json", "cases.json"].map(file => join(dir, file));
    if (existsSync(join(dir, MANAGED_NOTE)) || !files.every(file => existsSync(file) && lstatSync(file).isFile() && statSync(file).size <= MAX_EVAL_BYTES)) continue;
    try {
      const bundle = JSON.parse(readFileSync(files[0]!, "utf8")) as unknown, cases = JSON.parse(readFileSync(files[1]!, "utf8")) as unknown;
      if (bundleProblem(bundle) || !Array.isArray(cases)) continue;
      const usable = (cases as Case[]).filter(item => item && typeof item.id === "string" && item.input && typeof item.input === "object");
      found.push({ dir: `.openmerit/evals/${entry.name}`, bundle: redactBundle(bundle as TaskBundle), cases: redactBundle(usable) });
    } catch { continue; }
  }
  return found;
}

/** Clones, reviews and deletes the checkout. The evals Scout wrote in it come back beside the review. */
export async function reviewRepository(input: { fullName: string; branch: string; token: string | null; config: GitHubConfig; catalogue: Catalogue; reviewer: ReviewerConfig | null }): Promise<RepoReview & { evals: RepoEval[] }> {
  const started = Date.now();
  return withCheckout(input, async checkout => {
    const { reviewer, scan, supportCalls, tasks, unmapped, costUsd } = await reviewCheckout(checkout.root, input.catalogue, input.reviewer);
    const evals = repoEvals(checkout.root);
    const calls = scan.usages.filter(usage => usage.kind === "model");
    return {
      reviewer, commit: checkout.commit, branch: input.branch, files: scan.files, bytes: checkout.bytes,
      models: scan.models.map(model => ({ value: model.value, catalogueId: model.catalogueId, calls: model.usageIds.length })),
      modelCalls: calls.slice(0, MAX_CALLS).map(usage => ({ file: usage.file, line: usage.line, value: usage.value, catalogueId: usage.catalogueId, dynamic: usage.dynamic, envVar: usage.envVar ?? null })),
      totalCalls: calls.length, supportCalls, notListed: supportCalls ? `${supportCalls} more in tests, fixtures or docs, not listed` : null, tasks, unmapped, costUsd, durationMs: Date.now() - started, evals,
    };
  });
}
