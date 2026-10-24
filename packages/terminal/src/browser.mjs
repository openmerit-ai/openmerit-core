import { spawn } from 'node:child_process';

// By default, only open the loopback address returned by our own server.
// Callers can pass a stricter or different check. Never use a shell.
const terminalURL = url => { const target = new URL(url); return target.protocol === 'http:' && target.hostname === '127.0.0.1' && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url) && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash; };
export function browserCommand(url, platform = process.platform, env = process.env, allowed = terminalURL) {
  if (!allowed(url)) throw new Error('Refusing to open an unexpected URL.');
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return ['xdg-open', [url]];
  return null;
}

export async function openBrowser(url, { platform = process.platform, env = process.env, spawnProcess = spawn, timeoutMs = 3000, allowed } = {}) {
  const command = browserCommand(url, platform, env, allowed);
  if (!command) return false;
  return new Promise(resolve => {
    let child, timer;
    const finish = success => { clearTimeout(timer); resolve(success); };
    try {
      child = spawnProcess(command[0], command[1], { env, stdio: 'ignore', shell: false, detached: true });
      child.once('error', () => finish(false));
      child.once('exit', code => finish(code === 0));
      // Some desktop openers stay attached to the browser; don't wait on its lifetime.
      timer = setTimeout(() => finish(true), timeoutMs);
      child.unref();
    } catch { finish(false); }
  });
}
