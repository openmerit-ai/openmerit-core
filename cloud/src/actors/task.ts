// The task actor, keyed by account and task ID: the latest bundle, the labels the user gave, past
// results, the agent it belongs to and its watch schedule. The schedule is armed from the first job
// and checks the catalogue; a tick starts a watch job when the catalogue changed since the last run
// and the account says the task is watching, not frozen, idle or retired (account.ts `watchState`).
// Retiring disarms the schedule; the next openmerit_recommend call arms it again.
import { actor } from "rivetkit";
import type { Case, TaskBundle } from "../../../openmerit-core/src/ranking/index.ts";
import type { JobResult } from "../../../openmerit-core/src/job/report.ts";
import { services } from "../services.ts";
import type { Registry } from "../registry.ts";
import { startJob } from "../start.ts";

export interface TaskState {
  accountId: string;
  taskId: string;
  /** The project the task belongs to; absent on tasks created before projects, which are in the default project. */
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
  /** Whether the watch schedule and the catalogue subscription are set up. Off before the first job and once retired. */
  armed?: boolean;
  /** The catalogue version the last job ran on. */
  catalogueVersion: string | null;
  notices: string[];
}

const WATCH = "watch";
/** Actor state is saved on a timer; a task's changes must survive a crash right after them. */
const save = (c: { saveState: (opts: { immediate: boolean }) => Promise<void> }) => c.saveState({ immediate: true });

export const task = actor({
  createState: (_c, input: { accountId: string; taskId: string; environment: string; name: string }): TaskState => ({
    ...input, agent: null, bundle: null, labels: {}, written: null, jobs: [], lastResult: null, armed: false, catalogueVersion: null, notices: [],
  }),
  actions: {
    info: (c): TaskState => c.state,

    /** The bundle the coding agent sent with a new job. */
    /** The bundle a new job runs on. A recommend call (kind run) also arms the watch and makes an idle or retired task active again. */
    recordJob: async (c, input: { jobId: string; bundle: TaskBundle; agent: string | null; kind: "run" | "watch" }): Promise<void> => {
      c.state.bundle = input.bundle;
      c.state.agent = input.agent;
      c.state.jobs = [input.jobId, ...c.state.jobs].slice(0, 200);
      await save(c);
      const now = Date.now();
      if (input.kind === "run" && !armed(c.state)) {
        await c.cron.every({ name: WATCH, interval: Math.max(5_000, services().config.watchIntervalMs), action: "watchTick", maxHistory: 20 });
        await c.client<Registry>().catalogue.getOrCreate(["global"]).subscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
        c.state.armed = true;
        await save(c);
      }
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: input.agent, name: c.state.name, currentModel: input.bundle.current.model,
        pick: null, status: "running", lastRunAt: now, lastJobId: input.jobId, ...(input.kind === "run" ? { lastRecommendAt: now } : {}),
      });
    },

    /**
     * The bundle the task runs on next, set from the app: a task whose eval someone accepted after the task changed,
     * or one the coding agent named for its eval command before its first run.
     */
    prepare: async (c, bundle: TaskBundle): Promise<void> => { c.state.bundle = bundle; await save(c); },

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

    /**
     * The user approved a result's change and the coding agent applied its edit: later runs, such as
     * watch jobs, measure the pick as the current model, and each edited code ref has the code's new spelling.
     */
    adopt: async (c, input: { model: string; endpoint: string | null; edits: { file: string; line: number; before: string; after: string }[] }): Promise<void> => {
      const bundle = c.state.bundle;
      if (!bundle) return;
      const { endpoint: _old, ...current } = bundle.current;
      c.state.bundle = {
        ...bundle, current: { ...current, model: input.model, ...(input.endpoint ? { endpoint: input.endpoint } : {}) },
        ...(bundle.codeRefs ? { codeRefs: bundle.codeRefs.map(ref => ({ ...ref, spelling: input.edits.find(edit => edit.file === ref.file && edit.line === ref.line && edit.before === ref.spelling)?.after ?? ref.spelling })) } : {}),
      };
      await save(c);
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: input.model,
        pick: null, status: "switched",
      });
    },

    /** The coding agent removed this model call from the code: stop watching, keep the runs. The next recommend call brings the task back. */
    retire: async (c): Promise<void> => {
      if (armed(c.state)) {
        await c.cron.delete(WATCH);
        await c.client<Registry>().catalogue.getOrCreate(["global"]).unsubscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
        c.state.armed = false;
        await save(c);
      }
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: c.state.bundle?.current.model ?? "",
        pick: null, status: c.state.lastResult?.status ?? "new", retired: true,
      });
    },

    /** Starts a watch job when the task is watching and the catalogue changed since the last run. Runs on the schedule and when the catalogue tells it. */
    watchTick: async (c): Promise<{ started: string | null; reason: string }> => {
      if (!armed(c.state) || !c.state.bundle) return { started: null, reason: "not watching" };
      // The first job sets the catalogue version; until it finishes there is nothing to re-run against.
      if (!c.state.lastResult) return { started: null, reason: "the first run has not finished" };
      const client = c.client<Registry>();
      // Frozen, idle and retired are the account's to decide: it holds the guardrails and the last recommend call.
      const row = await client.account.getOrCreate([c.state.accountId]).task(c.state.taskId);
      if (row?.state !== "watching") return { started: null, reason: `task is ${row?.state ?? "unknown to the account"}` };
      const version = await client.catalogue.getOrCreate(["global"]).version();
      if (version === c.state.catalogueVersion) return { started: null, reason: `catalogue ${version} unchanged` };
      // The new job runs on this version: later ticks wait for the next one.
      const previous = c.state.catalogueVersion;
      c.state.catalogueVersion = version;
      await save(c);
      const started = await startJob(client, { accountId: c.state.accountId, environment: c.state.environment, agent: c.state.agent, bundle: c.state.bundle, kind: "watch", trigger: "watch", userId: null });
      if (!started.ok) {
        c.state.catalogueVersion = previous;
        c.state.notices = [`${new Date().toISOString()}: watch job not started: ${started.error}`, ...c.state.notices].slice(0, 20);
        await save(c);
        return { started: null, reason: started.error };
      }
      return { started: started.jobId, reason: `catalogue ${version} is newer than ${previous ?? "the last run's"}` };
    },

    /** For deleting the task or its account: stops the schedule and the catalogue's notices, which would otherwise recreate the task. */
    destroy: async (c): Promise<void> => {
      await c.cron.delete(WATCH).catch(() => undefined);
      await c.client<Registry>().catalogue.getOrCreate(["global"]).unsubscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
      c.destroy();
    },
  },
});

/** Tasks created before `armed` were armed by their first job unless openmerit_watch turned them off. */
function armed(state: TaskState): boolean {
  return state.armed ?? (state.jobs.length > 0 && (state as { watching?: boolean }).watching !== false);
}
