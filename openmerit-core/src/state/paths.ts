import { homedir } from "node:os";
import { join } from "node:path";

/** OpenMerit's directory on this machine: settings, secrets, the CLI's sign-in and a self-hosted server's data. */
export const openmeritHome = (env: Record<string, string | undefined> = process.env) => env.OPENMERIT_HOME ?? join(homedir(), ".openmerit");
