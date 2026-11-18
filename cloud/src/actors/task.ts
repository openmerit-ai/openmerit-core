// The task actor, keyed by account and task ID: the latest bundle, the labels the user gave, past
// results, the agent it belongs to and its watch schedule. Tasks are watched from their first job
// unless the coding agent turns it off: a watched task checks the catalogue on its schedule and
// starts a watch job when the catalogue changed since its last run.
import { actor } from "rivetkit";
import type { Case, TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import type { JobResult } from "../report.ts";
import { services } from "../services.ts";
import type { Registry } from "../registry.ts";
import { startJob } from "../start.ts";

export interface TaskState {
  accountId: string;
  taskId: string;
  environment: string;
  name: string;
  agent: string | null;
  bundle: TaskBundle | null;
  /** Labels keyed by the case input's hash (job.ts `caseKey`). */
  labels: Record<string, { expected: unknown; approved: boolean }>;
  /** The written cases the user approved in the label check, which later runs reuse instead of writing new ones. */
  written?: Case[] | null;
  jobs: string[];
  lastResult: { jobId: string; status: string; pick: string | null; endpoint: string | null; currentModel: string; finishedAt: string } | null;
  /** On from the first job; openmerit_watch turns it off, such as to freeze a model choice. */
  watching: boolean;
  /** The catalogue version the last job ran on. */
  catalogueVersion: string | null;
  notices: string[];
}

const WATCH = "watch";
/** Actor state is saved on a timer; a task's changes must survive a crash right after them. */
const save = (c: { saveState: (opts: { immediate: boolean }) => Promise<void> }) => c.saveState({ immediate: true });

export const task = actor({
  createState: (_c, input: { accountId: string; taskId: string; environment: string; name: string }): TaskState => ({
    ...input, agent: null, bundle: null, labels: {}, written: null, jobs: [], lastResult: null, watching: true, catalogueVersion: null, notices: [],
  }),
  actions: {
    info: (c): TaskState => c.state,

    /** The bundle the coding agent sent with a new job. */
    recordJob: async (c, input: { jobId: string; bundle: TaskBundle; agent: string | null }): Promise<void> => {
      const first = !c.state.jobs.length;
      c.state.bundle = input.bundle;
      c.state.agent = input.agent;
      c.state.jobs = [input.jobId, ...c.state.jobs].slice(0, 200);
      await save(c);
      // Every task is watched from its first job, until the coding agent turns it off.
      if (first && c.state.watching) {
        await c.cron.every({ name: WATCH, interval: Math.max(5_000, services().config.watchIntervalMs), action: "watchTick", maxHistory: 20 });
        await c.client<Registry>().catalogue.getOrCreate(["global"]).subscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
      }
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: input.agent, name: c.state.name, currentModel: input.bundle.current.model,
        pick: null, status: "running", lastRunAt: Date.now(), lastJobId: input.jobId, ...(first ? { watching: c.state.watching } : {}),
      });
    },

    labels: (c): TaskState["labels"] => c.state.labels,
    saveLabels: async (c, labels: TaskState["labels"]): Promise<void> => { Object.assign(c.state.labels, labels); await save(c); },
    written: (c): Case[] | null => c.state.written ?? null,
    saveWritten: async (c, cases: Case[]): Promise<void> => { c.state.written = cases; await save(c); },

    recordResult: async (c, input: { jobId: string; status: string; result: JobResult | null }): Promise<void> => {
      const pick = input.result?.pick ?? null;
      c.state.lastResult = { jobId: input.jobId, status: input.result?.status ?? input.status, pick: pick?.model ?? null, endpoint: pick?.endpoint ?? null, currentModel: c.state.bundle?.current.model ?? "", finishedAt: new Date().toISOString() };
      if (input.result) c.state.catalogueVersion = input.result.catalogueVersion;
      await save(c);
      // Saving per month needs the task's call volume, which no source reports yet.
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: c.state.bundle?.current.model ?? "",
        pick: pick?.model ?? null, status: input.result?.status ?? input.status,
      });
    },

    /** Turns watching on or off: a schedule that checks the catalogue, and the catalogue's notice when it changes. */
    setWatch: async (c, on: boolean): Promise<{ watching: boolean }> => {
      c.state.watching = on;
      await save(c);
      const catalogue = c.client<Registry>().catalogue.getOrCreate(["global"]);
      if (on) {
        await c.cron.every({ name: WATCH, interval: Math.max(5_000, services().config.watchIntervalMs), action: "watchTick", maxHistory: 20 });
        await catalogue.subscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
      } else {
        await c.cron.delete(WATCH);
        await catalogue.unsubscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
      }
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: c.state.bundle?.current.model ?? "",
        pick: null, status: c.state.lastResult?.status ?? "new", watching: on,
      });
      return { watching: on };
    },

    /** Starts a watch job when the catalogue changed since the last run. Runs on the schedule and when the catalogue tells it. */
    watchTick: async (c): Promise<{ started: string | null; reason: string }> => {
      if (!c.state.watching || !c.state.bundle) return { started: null, reason: "not watching" };
      // The first job sets the catalogue version; until it finishes there is nothing to re-run against.
      if (!c.state.lastResult) return { started: null, reason: "the first run has not finished" };
      const client = c.client<Registry>();
      const version = await client.catalogue.getOrCreate(["global"]).version();
      if (version === c.state.catalogueVersion) return { started: null, reason: `catalogue ${version} unchanged` };
      // The new job runs on this version: later ticks wait for the next one.
      const previous = c.state.catalogueVersion;
      c.state.catalogueVersion = version;
      await save(c);
      const started = await startJob(client, { accountId: c.state.accountId, environment: c.state.environment, agent: c.state.agent, bundle: c.state.bundle, kind: "watch" });
      if (!started.ok) {
        c.state.catalogueVersion = previous;
        c.state.notices = [`${new Date().toISOString()}: watch job not started: ${started.error}`, ...c.state.notices].slice(0, 20);
        await save(c);
        return { started: null, reason: started.error };
      }
      return { started: started.jobId, reason: `catalogue ${version} is newer than ${previous ?? "the last run's"}` };
    },

    /** For deleting an account. */
    destroy: (c): void => { c.destroy(); },
  },
});
