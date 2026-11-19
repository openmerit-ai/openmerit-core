// The app's Rivet registry: the account, task, job and catalogue actors, and a Viktor task's evaluation.
import { setup, type Client } from "rivetkit";
import { account } from "./actors/account.ts";
import { catalogue } from "./actors/catalogue.ts";
import { job } from "./actors/job.ts";
import { task } from "./actors/task.ts";
import { viktorJob } from "./actors/viktor-job.ts";

export const actors = { account, task, job, catalogue, viktorJob };

/**
 * On a Rivet Cloud actor node, the cluster sets RIVET_ENDPOINT, RIVET_TOKEN and RIVET_POOL and the
 * registry connects to it. `local` starts a local engine instead, for tests and development.
 */
export function createRegistry(local?: { port: number; token: string }) {
  return local
    ? setup({ use: actors, startEngine: true, startServices: false, enginePort: local.port, token: local.token, noWelcome: true })
    : setup({ use: actors, startEngine: false, startServices: false, runtime: "native", noWelcome: true });
}

export type Registry = ReturnType<typeof createRegistry>;
export type AppClient = Client<Registry>;
