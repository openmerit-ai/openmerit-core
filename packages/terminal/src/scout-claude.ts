import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Claude's private local scope belongs to the repository, not its subdirectories.
export async function claudeProject(root: string): Promise<string> {
  const options = { cwd: root, timeout: 10_000, windowsHide: true };
  let project: string;
  try {
    project = (await exec('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim() || root;
  } catch {
    return root;
  }
  const { stdout: worktrees } = await exec('git', ['worktree', 'list', '--porcelain', '-z'], options);
  const main = worktrees.split('\0')[0]?.slice('worktree '.length);
  if (!main || main === project) return project;
  const { stdout } = await exec('claude', ['--version'], options);
  const version = stdout.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!version) throw new Error('Could not determine Claude Code version for worktree setup. Check claude --version, then retry.');
  // Claude Code 2.1.63 began sharing project configuration with the main checkout.
  const major = Number(version[1]), minor = Number(version[2]), patch = Number(version[3]);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 63) ? main : project;
}
