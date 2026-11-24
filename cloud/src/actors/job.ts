// The job actor: one Rivet workflow per job, keyed by its job ID. It runs openmerit-core's task job
// (src/job/workflow.ts), the same workflow every host runs, with the cloud's actors as its host:
//
//   Source ▶ Cases (label check: wait for answers) ▶ Eval ▶ Models ▶ Ranking (grading loop) ▶ Agent eval ▶ Action
//
// The account actor holds the guardrails, the accepted eval, the endpoints and their keys, and the
// ledger; the task actor holds saved labels and the results; the catalogue actor the catalogue. A
// member's Claude or ChatGPT subscription can write the cases. Endpoint keys stay in this process's
// memory; they are never in step results or actor state, which are on disk.
import { workflow, type WorkflowStepContext } from "@rivet-dev/workflows";
import { queue } from "rivetkit";
import { forgetJob, jobView, newJobState, runTaskJob, type AnswersMessage, type JobHost, type JobInput, type JobState, type JobView } from "../../../openmerit-core/src/job/workflow.ts";
import { capture } from "../analytics.ts";
import { services } from "../services.ts";
import { PROVIDER_NAMES, subscriptionWriter } from "../subscriptions.ts";
import type { AppClient } from "../registry.ts";

export { applyAnswers, caseKey, labelQuestions, plannedSteps, type Answer, type Answers, type JobInput, type JobState, type JobStatus, type JobTrigger, type JobView, type LiveProgress, type Question } from "../../../openmerit-core/src/job/workflow.ts";

/** The queue openmerit_answer and the app send answers on. */
const queues = { answers: queue<AnswersMessage>() };
/** A step of the job workflow: its state, the actor client and the sleep grace period. */
type StepContext = WorkflowStepContext<JobState, undefined, undefined, undefined, JobInput, undefined, Record<never, never>, typeof queues>;

/** The app's actor client, from a step. Typed through AppClient: `s.client<Registry>()` here would make the registry's type depend on this actor's. */
const clientOf = (s: StepContext) => s.client() as unknown as AppClient;

/** The cloud's actors as the task job's host. */
const host: JobHost<StepContext> = {
  account: (s, accountId) => clientOf(s).account.getOrCreate([accountId]),
  task: (s, accountId, taskId) => clientOf(s).task.getOrCreate([accountId, taskId]),
  catalogue: s => clientOf(s).catalogue.getOrCreate(["global"]).get(),
  memberWriter: async (s, userId) => {
    const mine = await clientOf(s).user.getOrCreate([userId]).writer();
    return mine && { source: mine.provider, name: PROVIDER_NAMES[mine.provider], open: signal => subscriptionWriter(mine.provider, mine.credential, services().config.subscriptions, signal) };
  },
  settings: () => services(),
  completed: (s, status) => {
    const { input } = s.state;
    const userId = input.userId ?? null;
    // A watch job has no user: it is the account's, with no person profile.
    s.waitUntil(capture(services().config.posthog, "run_completed", userId ?? input.accountId, {
      interface: "cloud", status, trigger: input.trigger ?? (input.kind === "watch" ? "watch" : "mcp"), duration_ms: Date.now() - Date.parse(input.createdAt), account_id: input.accountId,
      ...(userId ? {} : { $process_person_profile: false }),
    }));
  },
};

export const job = workflow({
  createState: (_c, input: JobInput): JobState => newJobState(input),
  queues,
  run: async ctx => runTaskJob<StepContext>(ctx, host),
  actions: {
    status: (c): JobView => jobView(c.state, c.key[0]!),
    /** For deleting an account. */
    destroy: (c): void => { forgetJob(c.key[0]!); c.destroy(); },
  },
});
