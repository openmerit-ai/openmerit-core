import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** OpenMerit's global directory: settings, secrets and the SQLite history. Never inside a repository. */
export const openmeritHome = (env: Record<string, string | undefined> = process.env) => env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");

export interface Repo {
  /** Stable ID of the project: a hash of its real root path. */
  id: string;
  /** The project's directory: the Git root, or the subdirectory of it that holds the project (see findRepo). */
  root: string;
  /** The Git repository's root when it is not `root` itself; null when they are the same or outside Git. */
  gitRoot: string | null;
  /** Current commit, or null outside Git or before the first commit. */
  revision: string | null;
  dirty: boolean;
}

/** Files that make a directory a project of its own, such as one package of a monorepo. */
const PROJECT_FILES = ["package.json", "pyproject.toml", "setup.py", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "mix.exs", "deno.json"];

const git = (cwd: string, args: string[]) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

/**
 * The project containing `cwd`. Between `cwd` and its Git root, that is the nearest directory with
 * OpenMerit's `.openmerit/config.json`, else the nearest with a project file such as package.json,
 * else the Git root (or `cwd` outside Git). A project in a subdirectory of a larger repository, such
 * as one package of a monorepo, keeps its settings, scan and evals to that directory.
 */
export function findRepo(cwd: string): Repo {
  const start = realpathSync(cwd);
  const top = realpathSync(git(start, ["rev-parse", "--show-toplevel"]) ?? start);
  const dirs = [start];
  if (!relative(top, start).startsWith("..")) while (dirs.at(-1) !== top) dirs.push(dirname(dirs.at(-1)!));
  const root = dirs.find(dir => existsSync(join(dir, ".openmerit", "config.json"))) ?? dirs.find(dir => PROJECT_FILES.some(file => existsSync(join(dir, file)))) ?? top;
  const revision = git(root, ["rev-parse", "HEAD"]);
  // OpenMerit's own files (config, saved evals) do not make the code under test differ from the commit; "." limits it to the project.
  const status = git(root, ["status", "--porcelain", "--", ".", ":(exclude).openmerit"]);
  return { id: createHash("sha256").update(root).digest("hex").slice(0, 16), root, gitRoot: root === top ? null : top, revision, dirty: !!status };
}
