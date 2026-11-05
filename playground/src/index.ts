// HTTP entry point of the playground-claims Worker. Every route except GET / needs the
// PLAYGROUND_TOKEN bearer token; the approver CLI and scenario runner send it.

import { ClaimXmlError, parseClaimSubmission } from "./domain/eclaim.ts";
import { PLAN } from "./domain/plan.ts";
import type { Approval, EnrollmentApplication } from "./domain/types.ts";
import type { ModelOverrides } from "./models.ts";
import { SEED } from "../fixtures/seed.ts";
import { type ExperimentContext, runKey, VERSIONS } from "./tracing.ts";
import { APPROVAL_EVENT } from "./workflow.ts";

export { AdjudicationAgent, CodingAgent, EnrollmentAgent, FraudAgent, IntakeAgent } from "./agents.ts";
export { Ledger } from "./ledger.ts";
export { ClaimFlow, EnrollmentFlow } from "./workflow.ts";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

async function workflowStatus(binding: Workflow, id: string): Promise<unknown> {
  try {
    return await (await binding.get(id)).status();
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/") {
      return json({ service: "playground-claims", insurer: "Sahra Health (fictional)", plan: PLAN.name, versions: VERSIONS });
    }
    if (!env.PLAYGROUND_TOKEN || request.headers.get("authorization") !== `Bearer ${env.PLAYGROUND_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const ledger = env.LEDGER.getByName("sahra");

    if (request.method === "POST" && path === "/admin/seed") {
      await ledger.reset();
      await ledger.seed(SEED);
      return json({ members: SEED.members.length, providers: SEED.providers.length, clinicians: SEED.clinicians.length, paidClaims: SEED.paidClaims.length });
    }

    if (request.method === "POST" && path === "/enrollments") {
      const { application, runId, models } = (await request.json()) as { application: EnrollmentApplication; runId?: string; models?: ModelOverrides };
      if (await ledger.getEnrollment(application.applicationId)) return json({ error: `Application ${application.applicationId} already received` }, 409);
      await ledger.saveEnrollment({ application, decision: "pending", memberId: null, reason: "", runId: runId ?? null });
      await env.ENROLLMENT_FLOW.create({ id: runKey(application.applicationId, runId), params: { applicationId: application.applicationId, runId, models } });
      return json({ applicationId: application.applicationId, decision: "pending" }, 202);
    }

    const enrollment = /^\/enrollments\/([^/]+)$/.exec(path);
    if (request.method === "GET" && enrollment?.[1]) {
      const id = decodeURIComponent(enrollment[1]);
      const record = await ledger.getEnrollment(id);
      const member = record?.memberId ? await ledger.getMember(record.memberId) : null;
      return json({ enrollment: record, member, workflow: record && (await workflowStatus(env.ENROLLMENT_FLOW, runKey(id, record.runId))) });
    }

    if (request.method === "POST" && path === "/claims") {
      const { xml, bill, runId, models, experiment } = (await request.json()) as { xml: string; bill: string; runId?: string; models?: ModelOverrides; experiment?: ExperimentContext };
      let parsed;
      try {
        parsed = parseClaimSubmission(xml);
      } catch (error) {
        if (error instanceof ClaimXmlError) return json({ error: error.message }, 400);
        throw error;
      }
      const [claim] = parsed.claims;
      if (!claim || parsed.claims.length !== 1) return json({ error: "Submit exactly one claim per transaction" }, 400);
      if (claim.payerId !== PLAN.payerId) return json({ error: `PayerID must be ${PLAN.payerId}` }, 400);
      if (await ledger.getClaim(claim.id)) return json({ error: `Claim ${claim.id} already received` }, 409);
      await ledger.receiveClaim({ claim, xml, bill, runId });
      await env.CLAIM_FLOW.create({ id: runKey(claim.id, runId), params: { claimId: claim.id, runId, models, experiment } });
      return json({ claimId: claim.id, state: "received" }, 202);
    }

    if (request.method === "GET" && path === "/claims") {
      return json(await ledger.listClaims(url.searchParams.get("runId") ?? undefined));
    }

    const claimRoute = /^\/claims\/([^/]+)(\/approval)?$/.exec(path);
    if (claimRoute?.[1]) {
      const id = decodeURIComponent(claimRoute[1]);
      if (request.method === "GET" && !claimRoute[2]) {
        const record = await ledger.getClaim(id);
        return record ? json({ claim: record, workflow: await workflowStatus(env.CLAIM_FLOW, runKey(id, record.runId)) }) : json({ error: "not found" }, 404);
      }
      if (request.method === "POST" && claimRoute[2]) {
        const body = (await request.json()) as { decision: Approval["decision"]; by: string; note?: string };
        if (!["approve", "reject"].includes(body.decision) || !body.by?.trim()) return json({ error: "decision (approve|reject) and by are required" }, 400);
        const approval: Approval = { decision: body.decision, by: body.by.trim(), note: body.note, at: new Date().toISOString() };
        let record;
        try {
          record = await ledger.recordApproval(id, approval);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 409);
        }
        await (await env.CLAIM_FLOW.get(runKey(id, record.runId))).sendEvent({ type: APPROVAL_EVENT, payload: record.approval ?? approval });
        return json({ claimId: id, state: record.state, approval: record.approval });
      }
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
