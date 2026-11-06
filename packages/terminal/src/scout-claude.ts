import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Claude's private local scope belongs to the repository, not its subdirectories.
export async function claudeProject(root: string): Promise<string> {
  try {
    return (await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: root, timeout: 10_000, windowsHide: true,
    })).stdout.trim() || root;
  } catch {
    return root;
  }
}
