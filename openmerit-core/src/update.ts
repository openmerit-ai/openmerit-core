// Update check on every invocation: a newer `openmerit` on npm is offered, never installed silently.
// Interactive: ask, install with approval, then continue on the new version (or the installed one).
// Non-interactive or MCP: report it without prompting; MCP reports it through the client.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const packageVersion = (): string => (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export function newer(latest: string, current: string): boolean {
  const parse = (value: string) => value.replace(/^v/, "").split("-")[0]!.split(".").map(part => Number(part) || 0);
  const [a, b] = [parse(latest), parse(current)];
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  return !latest.includes("-") && current.includes("-") && parse(latest).join(".") === parse(current).join(".");
}

export interface UpdateInfo { current: string; latest: string | null; available: boolean; error?: string }

/** Asks the npm registry for the latest version. Offline or slow registries are not errors. */
export async function checkForUpdate(env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<UpdateInfo> {
  const current = packageVersion();
  if (env.OPENMERIT_NO_UPDATE_CHECK === "1") return { current, latest: null, available: false, error: "disabled" };
  try {
    const registry = (env.OPENMERIT_REGISTRY ?? "https://registry.npmjs.org").replace(/\/$/, "");
    const response = await fetcher(`${registry}/openmerit/latest`, { signal: AbortSignal.timeout(Number(env.OPENMERIT_UPDATE_TIMEOUT_MS ?? 2500)), headers: { accept: "application/json" } });
    if (!response.ok) return { current, latest: null, available: false, error: `registry HTTP ${response.status}` };
    const latest = (await response.json() as { version?: string }).version ?? null;
    return { current, latest, available: !!latest && newer(latest, current) };
  } catch (error) {
    return { current, latest: null, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const updateNotice = (info: UpdateInfo) => (info.available ? `openmerit ${info.latest} is available (installed ${info.current}). Update with: npm install -g openmerit@${info.latest}` : null);

/**
 * Interactive CLI flow. Returns the exit code of the updated process when it took over, or null to
 * continue in this process on the installed version.
 */
export async function offerUpdate(info: UpdateInfo, options: { interactive: boolean; confirm: (question: string) => Promise<boolean>; log: (line: string) => void; argv: string[]; env?: Record<string, string | undefined> }): Promise<number | null> {
  if (!info.available) return null;
  if (!options.interactive) { options.log(updateNotice(info)!); return null; }
  if (!(await options.confirm(`openmerit ${info.latest} is available (installed ${info.current}). Update now?`))) {
    options.log(`Continuing with openmerit ${info.current}.`);
    return null;
  }
  const env = options.env ?? process.env;
  const npm = env.OPENMERIT_NPM ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const install = spawnSync(npm, ["install", "-g", `openmerit@${info.latest}`], { stdio: ["ignore", "inherit", "inherit"], env });
  if (install.status !== 0) {
    options.log(`The update did not install (exit ${install.status ?? install.error?.message}); continuing with openmerit ${info.current}. Your history and settings are unchanged.`);
    return null;
  }
  options.log(`Updated to openmerit ${info.latest}; continuing on it.`);
  const rerun = spawnSync(env.OPENMERIT_BIN ?? "openmerit", options.argv, { stdio: "inherit", env: { ...env, OPENMERIT_NO_UPDATE_CHECK: "1" } });
  return rerun.status ?? 1;
}
