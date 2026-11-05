// The claim and enrollment pipelines as Cloudflare Workflows. Each agent step runs once per case
// (agents are idempotent by operation ID), checks that the agent recorded its result, and exports
// that run to Langfuse. Payment waits for a human approval event, and the ledger refuses to pay
// without one.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type AgentRunResult, instructionsFor } from "./agents.ts";
import type { Approval } from "./domain/types.ts";
import type { AgentRole, ModelChoice } from "./models.ts";
import { agentRunSpans, exportSpans, runKey, spanIdFor, type TraceContext, traceIdFor } from "./tracing.ts";

/** Scenario runs may name a model for every agent, to compare Scout's candidates. */
export type ModelOverride = NonNullable<ModelChoice["model"]>;

export interface ClaimFlowParams {
  claimId: string;
  runId?: string;
  model?: ModelOverride;
}

export interface EnrollmentFlowParams {
  applicationId: string;
  runId?: string;
  model?: ModelOverride;
}

export const APPROVAL_EVENT = "human-approval";

const AGENT_TIMEOUT = "10 minutes";

interface StepOutcome {
  status: string;
  traceId: string;
  summary?: string;
}

interface AgentStub {
  run(caseId: string, prompt: string, override?: ModelOverride): Promise<AgentRunResult>;
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

/** Runs one agent on a case and exports the run as its own trace in the case's session. */
async function runAgent(env: Env, input: { role: AgentRole; caseId: string; prompt: string; userId?: string; runId?: string; model?: ModelOverride }): Promise<AgentRunResult & { traceId: string }> {
  const started = Date.now();
  // One agent instance and trace per case and run, so a rerun starts fresh instead of replaying.
  const key = runKey(input.caseId, input.runId);
  const result = await agentStub(env, input.role, key).run(input.caseId, input.prompt, input.model);
  const traceId = await traceIdFor(`${key}/${input.role}`);
  const trace: TraceContext = {
    traceId,
    sessionId: input.caseId,
    userId: input.userId,
    traceName: STEP_NAMES[input.role],
    tags: ["sahra-health", input.role],
    metadata: { case_id: input.caseId, agent: input.role, ...(input.runId ? { run_id: input.runId } : {}), ...(input.model ? { model_override: `${input.model.provider}/${input.model.id}` } : {}) },
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
  return { ...result, traceId };
}

export class ClaimFlow extends WorkflowEntrypoint<Env, ClaimFlowParams> {
  override async run(event: WorkflowEvent<ClaimFlowParams>, step: WorkflowStep): Promise<{ state: string }> {
    const { claimId, runId, model } = event.payload;
    const ledger = this.env.LEDGER.getByName("sahra");
    const initial = await ledger.getClaim(claimId);
    if (!initial) throw new NonRetryableError(`Unknown claim ${claimId}`);
    const userId = initial.memberId ?? undefined;

    const pipeline: { role: AgentRole; prompt: string; recorded: (record: NonNullable<Awaited<ReturnType<typeof ledger.getClaim>>>) => boolean }[] = [
      { role: "intake", prompt: `Process the itemized bill and eClaimLink submission for claim ${claimId}.`, recorded: (record) => record.extraction !== null },
      { role: "coding", prompt: `Review the coding on claim ${claimId}.`, recorded: (record) => record.coding !== null },
      { role: "adjudication", prompt: `Adjudicate claim ${claimId}.`, recorded: (record) => record.adjudication !== null },
      { role: "fraud", prompt: `Assess claim ${claimId} for fraud, waste and abuse.`, recorded: (record) => record.fraud !== null },
    ];

    for (const stage of pipeline) {
      await step.do(STEP_NAMES[stage.role], { timeout: AGENT_TIMEOUT, retries: { limit: 1, delay: "10 seconds", backoff: "constant" } }, async (): Promise<StepOutcome> => {
        const result = await runAgent(this.env, { role: stage.role, caseId: claimId, prompt: stage.prompt, userId, runId, model });
        const record = await ledger.getClaim(claimId);
        if (!record || !stage.recorded(record)) {
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
    const { applicationId, runId, model } = event.payload;
    const ledger = this.env.LEDGER.getByName("sahra");
    return step.do(STEP_NAMES.enrollment, { timeout: AGENT_TIMEOUT, retries: { limit: 1, delay: "10 seconds", backoff: "constant" } }, async () => {
      await runAgent(this.env, { role: "enrollment", caseId: applicationId, prompt: `Process enrollment application ${applicationId}.`, runId, model });
      const record = await ledger.getEnrollment(applicationId);
      if (!record || record.decision === "pending") throw new NonRetryableError("Enrollment agent ended without a decision");
      return { decision: record.decision };
    });
  }
}
