import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** OpenMerit's global directory: settings, secrets and the SQLite history. Never inside a repository. */
export const openmeritHome = (env: Record<string, string | undefined> = process.env) => env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");

export interface Repo {
  /** Stable ID of the checkout: a hash of its real root path. */
  id: string;
  root: string;
  /** Current commit, or null outside Git or before the first commit. */
  revision: string | null;
  dirty: boolean;
}

const git = (cwd: string, args: string[]) => {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

/** The repository containing `cwd`: its Git root, or `cwd` itself outside Git. */
export function findRepo(cwd: string): Repo {
  const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd);
  const revision = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain"]);
  return { id: createHash("sha256").update(root).digest("hex").slice(0, 16), root, revision, dirty: !!status };
}
