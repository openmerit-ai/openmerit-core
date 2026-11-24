// GitHub repositories an account adds for review. It parses what the user pasted, checks access
// with GitHub's free REST API, shallow-clones the default branch into a temporary sandbox directory,
// reviews the checkout and deletes it. Read-only: OpenMerit sends GitHub only GET requests and git's
// fetch, and never pushes, opens a pull request or writes to a repository. Nothing in a checkout runs:
// git runs no hooks, checks symlinks out as plain files and gets no secret in its environment.
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalogue } from "./engine.ts";
import { scanRepo, type ScanResult } from "../../openmerit-core/src/scout/scan.ts";
import type { TaskBundle } from "../../openmerit-core/src/ranking/index.ts";

export interface GitHubConfig {
  /** GitHub's REST API, https://api.github.com. Tests point it at a fake. */
  apiUrl: string;
  /** Where repositories are cloned from, https://github.com. Tests point it at a fake. */
  gitUrl: string;
  /** Largest repository OpenMerit clones, by GitHub's reported size and on disk while cloning. */
  maxBytes: number;
  /** Longest a clone may take. */
  cloneTimeoutMs: number;
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
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const minutes = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : null;
      return `GitHub's rate limit for OpenMerit is used up. Try again${minutes ? ` in ${minutes} min` : " later"}${token ? "" : ", or add the repository with a token"}.`;
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
  /** `scan` until openmerit-core's reviewRepo writes task specs; then `review`. */
  reviewer: "scan";
  commit: string;
  branch: string;
  files: number;
  bytes: number;
  /** The models the code names, the application's own code first, with how many calls name each. */
  models: { value: string; catalogueId: string | null; calls: number }[];
  /** At most MAX_CALLS, in the order the scan found them. */
  modelCalls: ModelCall[];
  /** Every model call the scan found, including those past MAX_CALLS. */
  totalCalls: number;
  /** One spec per task. Empty until the review prompt writes them. */
  tasks: TaskBundle[];
  durationMs: number;
}

const MAX_CALLS = 200;

/**
 * The review entry point: reads a checkout and returns its task specs. Until openmerit-core's
 * `reviewRepo` (step 3 of the eval-generation plan) lands, it is the repository scan alone, which
 * lists the model calls and writes no task spec.
 */
export async function reviewCheckout(root: string, catalogue: Catalogue): Promise<{ reviewer: "scan"; scan: ScanResult; tasks: TaskBundle[] }> {
  return { reviewer: "scan", scan: scanRepo(root, catalogue), tasks: [] };
}

/** Clones, reviews and deletes the checkout. */
export async function reviewRepository(input: { fullName: string; branch: string; token: string | null; config: GitHubConfig; catalogue: Catalogue }): Promise<RepoReview> {
  const started = Date.now();
  return withCheckout(input, async checkout => {
    const { reviewer, scan, tasks } = await reviewCheckout(checkout.root, input.catalogue);
    const calls = scan.usages.filter(usage => usage.kind === "model");
    return {
      reviewer, commit: checkout.commit, branch: input.branch, files: scan.files, bytes: checkout.bytes,
      models: scan.models.map(model => ({ value: model.value, catalogueId: model.catalogueId, calls: model.usageIds.length })),
      modelCalls: calls.slice(0, MAX_CALLS).map(usage => ({ file: usage.file, line: usage.line, value: usage.value, catalogueId: usage.catalogueId, dynamic: usage.dynamic, envVar: usage.envVar ?? null })),
      totalCalls: calls.length, tasks, durationMs: Date.now() - started,
    };
  });
}
