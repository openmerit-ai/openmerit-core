// The task actor, keyed by account and task ID: the latest bundle, the labels the user gave, past
// results, the agent it belongs to and its watch. The first job arms the watch, which subscribes the task
// to the catalogue; when a refresh adds models or makes some cheaper, a tick starts a watch job only
// when one of them could beat what the task has now (job/pool.ts `couldBeat`) and the account says the
// task is watching, not frozen, idle or retired (account.ts `watchState`). There is no schedule of its own.
// Retiring disarms the watch; the next openmerit_recommend call arms it again.
import { actor } from "rivetkit";
import type { Case, TaskBundle } from "../../ranking/index.ts";
import type { JobResult } from "../../job/report.ts";
import type { Registry } from "../registry.ts";
import { DEFAULT_PROJECT, startJob } from "../start.ts";
import { couldBeat } from "../../job/pool.ts";

export interface TaskState {
  accountId: string;
  taskId: string;
  /** The project the task belongs to; absent on tasks created before projects, which are in the default project. */
  projectId?: string;
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
  /** Whether the catalogue subscription is set up. Off before the first job and once retired. */
  armed?: boolean;
  /** The catalogue version the last job ran on. */
  catalogueVersion: string | null;
  notices: string[];
}

const WATCH = "watch";
/** Actor state is saved on a timer; a task's changes must survive a crash right after them. */
const save = (c: { saveState: (opts: { immediate: boolean }) => Promise<void> }) => c.saveState({ immediate: true });

export const task = actor({
  createState: (_c, input: { accountId: string; taskId: string; projectId: string; environment: string; name: string }): TaskState => ({
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
        await c.client<Registry>().catalogue.getOrCreate(["global"]).subscribe({ accountId: c.state.accountId, taskId: c.state.taskId });
        c.state.armed = true;
        await save(c);
      }
      await c.client<Registry>().account.getOrCreate([c.state.accountId]).upsertTask({
        id: c.state.taskId, projectId: c.state.projectId ?? DEFAULT_PROJECT, environment: c.state.environment, agent: input.agent, name: c.state.name, currentModel: input.bundle.current.model,
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
        id: c.state.taskId, projectId: c.state.projectId ?? DEFAULT_PROJECT, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: c.state.bundle?.current.model ?? "",
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
        id: c.state.taskId, projectId: c.state.projectId ?? DEFAULT_PROJECT, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: input.model,
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
        id: c.state.taskId, projectId: c.state.projectId ?? DEFAULT_PROJECT, environment: c.state.environment, agent: c.state.agent, name: c.state.name, currentModel: c.state.bundle?.current.model ?? "",
        pick: null, status: c.state.lastResult?.status ?? "new", retired: true,
      });
    },

    /**
     * Starts a watch job when the task is watching and a catalogue refresh's new or cheaper `models` could beat what it
     * has now. The catalogue calls it. A call without models is the daily schedule tasks had before: it removes it.
     */
    watchTick: async (c, input?: { models: string[] }): Promise<{ started: string | null; reason: string }> => {
      if (!input) {
        await c.cron.delete(WATCH).catch(() => false);
        return { started: null, reason: "the daily check is gone: a catalogue change starts a watch job" };
      }
      if (!armed(c.state) || !c.state.bundle) return { started: null, reason: "not watching" };
      // The first job sets the catalogue version; until it finishes there is nothing to re-run against.
      if (!c.state.lastResult) return { started: null, reason: "the first run has not finished" };
      const client = c.client<Registry>();
      // Frozen, idle and retired are the account's to decide: it holds the guardrails and the last recommend call.
      const account = client.account.getOrCreate([c.state.accountId]);
      const row = await account.task(c.state.taskId);
      if (row?.state !== "watching") return { started: null, reason: `task is ${row?.state ?? "unknown to the account"}` };
      const catalogue = await client.catalogue.getOrCreate(["global"]).get();
      if (catalogue.version === c.state.catalogueVersion) return { started: null, reason: `catalogue ${catalogue.version} unchanged` };
      const projectId = c.state.projectId ?? DEFAULT_PROJECT, bundle = c.state.bundle;
      const [endpoints, guardrails, accepted] = await Promise.all([
        account.endpointsForJob(projectId), account.resolveGuardrails({ projectId, environment: c.state.environment, agent: c.state.agent, taskId: c.state.taskId }), account.evalFor(c.state.taskId),
      ]);
      // The pick to beat: the last run's, while the task still runs the model that run measured against.
      const last = c.state.lastResult;
      const pick = last.pick && last.currentModel === bundle.current.model ? last.pick : null;
      const beats = couldBeat({ catalogue, endpoints, bundle, guardrails: guardrails.effective, wide: accepted?.bar === "criteria", pick, changed: input.models });
      // This version is decided either way: the next tick waits for the next catalogue.
      const previous = c.state.catalogueVersion;
      c.state.catalogueVersion = catalogue.version;
      await save(c);
      if (!beats.length) return { started: null, reason: `no new or cheaper model in its pool is as capable as ${bundle.current.model} and cheaper than ${pick ?? bundle.current.model}` };
      const started = await startJob(client, { accountId: c.state.accountId, projectId, environment: c.state.environment, agent: c.state.agent, bundle, kind: "watch", trigger: "watch", userId: null });
      if (!started.ok) {
        c.state.catalogueVersion = previous;
        c.state.notices = [`${new Date().toISOString()}: watch job not started: ${started.error}`, ...c.state.notices].slice(0, 20);
        await save(c);
        return { started: null, reason: started.error };
      }
      return { started: started.jobId, reason: `${beats.join(", ")} could beat ${pick ?? bundle.current.model}` };
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
