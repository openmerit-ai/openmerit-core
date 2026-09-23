import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POLL_SECONDS = 300;

export interface PiWakeupOptions {
  readonly projectRoot: string;
  readonly extensionPath: string;
  readonly provider: string;
  readonly modelId: string;
}

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
}

export function piWakeupLabel(projectRoot: string): string {
  return `com.openmerit.pi.${projectHash(projectRoot)}`;
}

export function piWakeupPlistPath(projectRoot: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${piWakeupLabel(projectRoot)}.plist`);
}

function managedMarker(projectRoot: string): string {
  return `<!-- openmerit-managed:${projectHash(projectRoot)} -->`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

async function executable(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch { /* try the next PATH entry */ }
  }
  throw new Error(`${name} is not on PATH`);
}

export function renderPiWakeupPlist(options: PiWakeupOptions, piPath: string, runnerPath: string): string {
  const args = [process.execPath, runnerPath, resolve(options.projectRoot), piPath,
    resolve(options.extensionPath), options.provider, options.modelId];
  const argumentsXml = args.map((argument) => `      <string>${xml(argument)}</string>`).join("\n");
  const path = [dirname(process.execPath), dirname(piPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${managedMarker(options.projectRoot)}
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(piWakeupLabel(options.projectRoot))}</string>
  <key>ProgramArguments</key><array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key><string>${xml(resolve(options.projectRoot))}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${POLL_SECONDS}</integer>
</dict>
</plist>
`;
}

async function loaded(label: string): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid?.()}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

export async function provisionPiWakeup(options: PiWakeupOptions): Promise<string> {
  if (process.platform !== "darwin" || process.getuid === undefined) {
    throw new Error("Persistent Pi wakeups require a macOS user LaunchAgent.");
  }
  if (!options.provider || !options.modelId) throw new Error("Select an authenticated Pi model before scheduling.");
  const piPath = await executable("pi");
  const auth = await execFileAsync(piPath, ["auth", "check", "--model", `${options.provider}/${options.modelId}`], {
    env: {
      HOME: homedir(),
      PATH: [dirname(process.execPath), dirname(piPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    },
  });
  if (auth.stdout.trim() !== "ready") {
    throw new Error(`Pi authentication is not ready for ${options.provider}/${options.modelId} in the background environment.`);
  }
  const extensionPath = resolve(options.extensionPath);
  const runnerPath = join(dirname(extensionPath), `wakeup${extname(extensionPath)}`);
  await access(runnerPath, constants.R_OK);
  const path = piWakeupPlistPath(options.projectRoot);
  const content = renderPiWakeupPlist({ ...options, extensionPath }, piPath, runnerPath);
  let prior: string | undefined;
  try { prior = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (prior && !prior.includes(managedMarker(options.projectRoot))) {
    throw new Error(`Refusing to replace unmanaged LaunchAgent ${basename(path)}.`);
  }
  const label = piWakeupLabel(options.projectRoot);
  if (prior === content && await loaded(label)) return path;
  if (await loaded(label)) await execFileAsync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid()}`, path]);
  return path;
}

export async function removePiWakeup(projectRoot: string): Promise<boolean> {
  if (process.platform !== "darwin" || process.getuid === undefined) return false;
  const path = piWakeupPlistPath(projectRoot);
  let content: string;
  try { content = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!content.includes(managedMarker(projectRoot))) {
    throw new Error(`Refusing to remove unmanaged LaunchAgent ${basename(path)}.`);
  }
  const label = piWakeupLabel(projectRoot);
  if (await loaded(label)) await execFileAsync("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
  await unlink(path);
  return true;
}
