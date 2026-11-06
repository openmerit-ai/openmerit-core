// The claim and enrollment pipelines as Cloudflare Workflows. Each agent step runs once per case
// (agents are idempotent by operation ID), checks that the agent recorded its result, and exports
// that run to Langfuse with its task-level scores. Payment waits for a human approval event, and the ledger refuses to pay
// without one.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type AgentRunResult, instructionsFor } from "./agents.ts";
import type { Approval } from "./domain/types.ts";
import { ledgerName } from "./ledger.ts";
import { type AgentRole, type ModelOverride, type ModelOverrides, TRIAGE_MODEL } from "./models.ts";
import { TRIAGE_QUESTION, triageClaim, triageState } from "./triage.ts";
import { agentRunSpans, type ExperimentContext, exportSpans, postScore, runKey, type ScoreInput, spanIdFor, type TraceContext, traceIdFor, transcriptCounts } from "./tracing.ts";

export interface ClaimFlowParams {
  claimId: string;
  runId?: string;
  /** Scenario runs may override the recorded model per agent, to compare Scout's candidates. */
  models?: ModelOverrides;
  /** Scenario runs link the claim's final agent trace to this Langfuse experiment (dataset item = claim ID). */
  experiment?: ExperimentContext;
  /** Scenario runs may triage with another OpenRouter decision model, to compare Scout's candidates. */
  triageModel?: string;
}

export interface EnrollmentFlowParams {
  applicationId: string;
  runId?: string;
  models?: ModelOverrides;
  /** Scenario runs link the enrollment agent's trace to this Langfuse experiment (dataset item = application ID). */
  experiment?: ExperimentContext;
}

export const APPROVAL_EVENT = "human-approval";

const AGENT_TIMEOUT = "10 minutes";

const NUDGE = "You ended without recording your result. If a tool rejected a call, fix the arguments as its error says and call it again. Finish by calling your record tool.";

interface StepOutcome {
  status: string;
  traceId: string;
  summary?: string;
}

interface AgentStub {
  run(input: { caseId: string; runId?: string; prompt: string; override?: ModelOverride; attempt?: number }): Promise<AgentRunResult>;
}

// Typed by hand: the generated RPC type of the transcript entries is too deep for TypeScript.
function agentStub(env: Env, role: AgentRole, caseId: string): AgentStub {
  const stub = (namespace: { getByName(name: string): unknown }): AgentStub => namespace.getByName(caseId) as AgentStub;
  switch (role) {
    case "enrollment":
      return stub(env.ENROLLMENT_AGENT);
    case "intake":
      return stub(env.INTAKE_AGENT);
    case "coding":
      return stub(env.CODING_AGENT);
    case "adjudication":
      return stub(env.ADJUDICATION_AGENT);
    case "fraud":
      return stub(env.FRAUD_AGENT);
  }
}

const STEP_NAMES: Record<AgentRole, string> = {
  enrollment: "assess-enrollment",
  intake: "extract-claim",
  coding: "review-coding",
  adjudication: "adjudicate-claim",
  fraud: "assess-fraud",
};

/**
 * Runs one agent on a case, checks that it recorded its result, and exports the run as its own trace
 * in the case's session with Sahra's task-level scores. With `experiment`, the trace becomes the
 * case's experiment item when it is the case's last agent run: the last agent, or the one that failed.
 */
async function runAgent(
  env: Env,
  input: { role: AgentRole; caseId: string; prompt: string; userId?: string; runId?: string; model?: ModelOverride; last?: boolean; experiment?: ExperimentContext },
  recorded: () => Promise<boolean>,
): Promise<AgentRunResult & { traceId: string; recorded: boolean }> {
  const started = Date.now();
  // One agent instance and trace per case and run, so a rerun starts fresh instead of replaying.
  const key = runKey(input.caseId, input.runId);
  const stub = agentStub(env, input.role, key);
  let result = await stub.run({ caseId: input.caseId, runId: input.runId, prompt: input.prompt, override: input.model });
  let isRecorded = await recorded();
  // An agent that ended without recording (often after one rejected tool call) gets one nudge in
  // the same session. The trace covers the whole session, and `nudges` shows that it was needed.
  let nudges = 0;
  if (!isRecorded && result.model) {
    nudges = 1;
    result = await stub.run({ caseId: input.caseId, runId: input.runId, prompt: NUDGE, override: input.model, attempt: nudges });
    isRecorded = await recorded();
  }
  const traceId = await traceIdFor(`${key}/${input.role}`);
  const rootObservationId = await spanIdFor(`${key}/${input.role}/agent`);
  const final = input.experiment && (input.last || !isRecorded);
  const trace: TraceContext = {
    traceId,
    sessionId: input.caseId,
    userId: input.userId,
    traceName: STEP_NAMES[input.role],
    tags: ["sahra-health", input.role, ...(input.experiment ? [`experiment:${input.experiment.id}`] : [])],
    metadata: { case_id: input.caseId, agent: input.role, ...(input.runId ? { run_id: input.runId } : {}), ...(input.model ? { model_override: `${input.model.provider}/${input.model.id}` } : {}) },
    ...(final && input.experiment ? { experiment: { ...input.experiment, itemId: input.caseId, rootObservationId } } : {}),
  };
  const spans = await agentRunSpans({
    key: `${key}/${input.role}`,
    name: STEP_NAMES[input.role],
    instructions: instructionsFor(input.role),
    prompt: input.prompt,
    model: result.model ?? "none",
    entries: result.entries,
    status: result.status,
    reason: result.reason,
    text: result.text,
    startedMs: started,
    endedMs: Date.now(),
    metadata: { case_id: input.caseId },
  });
  await exportSpans(env, trace, spans);
  const counts = transcriptCounts(result.entries);
  const scores: Omit<ScoreInput, "traceId" | "observationId">[] = [
    { name: "model-calls", value: counts.modelCalls, dataType: "NUMERIC", comment: `${input.role} agent model calls` },
    { name: "rejected-tool-calls", value: counts.rejectedToolCalls, dataType: "NUMERIC", comment: "tool calls answered by a <harness> or [error] result" },
    { name: "nudges", value: nudges, dataType: "NUMERIC", comment: "follow-up prompts after the agent ended without recording its result" },
    { name: "result-recorded", value: isRecorded ? 1 : 0, dataType: "BOOLEAN", comment: `${input.role} agent ended ${result.status}${result.reason ? ` (${result.reason})` : ""}` },
  ];
  for (const score of scores) {
    try {
      await postScore(env, { ...score, traceId, observationId: rootObservationId, metadata: { level: "task", agent: input.role } });
    } catch (error) {
      console.error(`Could not send score ${score.name} for ${input.caseId}`, error);
    }
  }
  return { ...result, traceId, recorded: isRecorded };
}

export class ClaimFlow extends WorkflowEntrypoint<Env, ClaimFlowParams> {
  override async run(event: WorkflowEvent<ClaimFlowParams>, step: WorkflowStep): Promise<{ state: string }> {
    const { claimId, runId, models, experiment } = event.payload;
    const ledger = this.env.LEDGER.getByName(ledgerName(runId));
    const initial = await ledger.getClaim(claimId);
    if (!initial) throw new NonRetryableError(`Unknown claim ${claimId}`);
    const userId = initial.memberId ?? undefined;

    // Shadow-mode triage: recorded and traced, but the claim takes the full pipeline either way.
    const triageModel = event.payload.triageModel ?? TRIAGE_MODEL.id;
    if (triageModel) {
      await step.do("triage-claim", { timeout: "2 minutes", retries: { limit: 1, delay: "10 seconds", backoff: "constant" } }, async () => {
        const member = initial.memberId ? await ledger.getMember(initial.memberId) : null;
        const state = triageState({
          record: initial,
          member,
          clinicians: await ledger.getClinicians([...new Set(initial.claim.activities.map((activity) => activity.clinician))]),
          history: member ? await ledger.claimHistory(member.id, claimId) : [],
          providerStats: await ledger.providerStats(initial.providerId),
        });
        const triage = await triageClaim(this.env.OPENROUTER_API_KEY, triageModel, state, claimId);
        await ledger.setTriage(claimId, triage);
        const key = runKey(claimId, runId);
        const rootId = await spanIdFor(`${key}/triage/root`);
        const ended = Date.parse(triage.startedAt) + triage.latencyMs;
        await exportSpans(this.env, {
          traceId: await traceIdFor(`${key}/triage`),
          sessionId: claimId,
          userId,
          traceName: "triage-claim",
          tags: ["sahra-health", "triage", ...(experiment ? [`experiment:${experiment.id}`] : [])],
          metadata: { case_id: claimId, ...(runId ? { run_id: runId } : {}) },
        }, [
          { spanId: rootId, name: "triage-claim", type: "chain", startMs: Date.parse(triage.startedAt), endMs: ended, input: { claimId }, output: { needsReview: triage.needsReview } },
          {
            spanId: await spanIdFor(`${key}/triage/decision`),
            parentSpanId: rootId,
            name: "decide-needs-review",
            type: "generation",
            startMs: Date.parse(triage.startedAt),
            endMs: ended,
            model: triage.servedModel ?? triageModel,
            input: { questions: { needs_review: TRIAGE_QUESTION }, state },
            output: triage.error ? { error: triage.error } : { needs_review: triage.needsReview },
            ...(triage.usage ? { usage: { input: triage.usage.inputTokens, output: triage.usage.outputTokens, total: triage.usage.inputTokens + triage.usage.outputTokens } } : {}),
            ...(triage.usage?.costUsd ? { cost: { total: triage.usage.costUsd } } : {}),
            ...(triage.error ? { level: "ERROR" as const, statusMessage: triage.error.slice(0, 200) } : {}),
            metadata: { requested_model: triageModel, ...(triage.provider ? { provider: triage.provider } : {}) },
          },
        ]);
        return { needsReview: triage.needsReview, error: triage.error ?? null };
      });
    }

    const pipeline: { role: AgentRole; prompt: string; recorded: (record: NonNullable<Awaited<ReturnType<typeof ledger.getClaim>>>) => boolean }[] = [
      { role: "intake", prompt: `Process the itemized bill and eClaimLink submission for claim ${claimId}.`, recorded: (record) => record.extraction !== null },
      { role: "coding", prompt: `Review the coding on claim ${claimId}.`, recorded: (record) => record.coding !== null },
      { role: "adjudication", prompt: `Adjudicate claim ${claimId}.`, recorded: (record) => record.adjudication !== null },
      { role: "fraud", prompt: `Assess claim ${claimId} for fraud, waste and abuse.`, recorded: (record) => record.fraud !== null },
    ];

    for (const [index, stage] of pipeline.entries()) {
      await step.do(STEP_NAMES[stage.role], { timeout: AGENT_TIMEOUT, retries: { limit: 1, delay: "10 seconds", backoff: "constant" } }, async (): Promise<StepOutcome> => {
        const result = await runAgent(
          this.env,
          { role: stage.role, caseId: claimId, prompt: stage.prompt, userId, runId, model: models?.[stage.role], last: index === pipeline.length - 1, experiment },
          async () => {
            const record = await ledger.getClaim(claimId);
            return !!record && stage.recorded(record);
          },
        );
        if (!result.recorded) {
          const message = `${stage.role} agent ended ${result.status}${result.reason ? ` (${result.reason})` : ""} without recording its result`;
          await ledger.fail(claimId, message);
          throw new NonRetryableError(message);
        }
        return { status: result.status, traceId: result.traceId, summary: result.text?.slice(0, 500) };
      });
    }

    await step.do("request-approval", async () => {
      await ledger.requestApproval(claimId);
      return { state: "awaiting_approval" };
    });

    const approvalEvent = await step.waitForEvent<Approval>("wait-for-human-approval", { type: APPROVAL_EVENT, timeout: "7 days" });
    const approval = approvalEvent.payload;
    const waitStarted = new Date(approvalEvent.timestamp).getTime();

    return step.do("settle-claim", async () => {
      const recorded = await ledger.getClaim(claimId);
      if (!recorded?.approval) throw new NonRetryableError("Approval event arrived without a recorded approval");
      const paid = recorded.approval.decision === "approve" ? await ledger.issuePayment(claimId) : recorded;
      const key = runKey(claimId, runId);
      const traceId = await traceIdFor(`${key}/settlement`);
      const rootId = await spanIdFor(`${key}/settlement`);
      const trace: TraceContext = {
        traceId,
        sessionId: claimId,
        userId,
        traceName: "settle-claim",
        tags: ["sahra-health", "settlement"],
        metadata: { case_id: claimId, ...(runId ? { run_id: runId } : {}) },
      };
      const at = new Date(approval.at).getTime();
      await exportSpans(this.env, trace, [
        {
          spanId: rootId,
          name: "settle-claim",
          type: "chain",
          startMs: Math.min(at, waitStarted),
          endMs: Date.now(),
          input: { proposed: recorded.adjudication?.totals, fraud: recorded.fraud && { score: recorded.fraud.score, recommendation: recorded.fraud.recommendation } },
          output: { state: paid.state, payment: paid.payment },
        },
        {
          spanId: await spanIdFor(`${key}/settlement/approval`),
          parentSpanId: rootId,
          name: "record-human-approval",
          type: "guardrail",
          startMs: at,
          endMs: at,
          input: { claimId },
          output: recorded.approval,
          metadata: { approver: recorded.approval.by, decision: recorded.approval.decision },
        },
        ...(paid.payment
          ? [{ spanId: await spanIdFor(`${key}/settlement/payment`), parentSpanId: rootId, name: "issue-payment", type: "tool" as const, startMs: Date.now(), endMs: Date.now(), input: { claimId }, output: paid.payment }]
          : []),
      ]);
      return { state: paid.state };
    });
  }
}

export class EnrollmentFlow extends WorkflowEntrypoint<Env, EnrollmentFlowParams> {
  override async run(event: WorkflowEvent<EnrollmentFlowParams>, step: WorkflowStep): Promise<{ decision: string }> {
    const { applicationId, runId, models, experiment } = event.payload;
    const ledger = this.env.LEDGER.getByName(ledgerName(runId));
    return step.do(STEP_NAMES.enrollment, { timeout: AGENT_TIMEOUT, retries: { limit: 1, delay: "10 seconds", backoff: "constant" } }, async () => {
      const decided = async () => {
        const record = await ledger.getEnrollment(applicationId);
        return record && record.decision !== "pending" ? record.decision : null;
      };
      await runAgent(this.env, { role: "enrollment", caseId: applicationId, prompt: `Process enrollment application ${applicationId}.`, runId, model: models?.enrollment, last: true, experiment }, async () => !!(await decided()));
      const decision = await decided();
      if (!decision) throw new NonRetryableError("Enrollment agent ended without a decision");
      return { decision };
    });
  }
}
