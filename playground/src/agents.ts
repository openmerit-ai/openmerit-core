// The five Sahra Health agents. Each is a Durable Object running Pi Durable through the Agents SDK's
// PiHarness, with one instance per case (claim or enrollment application) so every case has its own
// transcript. Agents judge and record; deterministic tools hold the rules and the money math, and
// no agent can pay a claim.

import { DurableObject } from "cloudflare:workers";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, defineTool, type EntryRecord, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { computeRemittance, requiredDenials } from "./domain/adjudicate.ts";
import { DELETED_ICD10CM, findActivity, findDiagnosis } from "./domain/codes.ts";
import { DENIAL_CODES, PLAN } from "./domain/plan.ts";
import type { ActivityType, Member } from "./domain/types.ts";
import { ledgerName } from "./ledger.ts";
import { AGENT_MODELS, type AgentRole, type ModelChoice, modelLabel } from "./models.ts";

export interface AgentRunResult {
  role: AgentRole;
  model: string | null;
  status: "done" | "unanswered";
  reason?: string;
  text?: string;
  entries: EntryRecord[];
}

type Tools = ToolRegistration[];
interface RoleDefinition {
  instructions: string;
  tools: (agent: SahraAgent) => Tools;
}

const SHARED_RULES = `You work for Sahra Health, a fictional health insurer in Dubai. All people, IDs and amounts are fictional test data.
Work only from what your tools return; never invent codes, members, amounts or history.
Finish by calling your record tool exactly once, then reply with a one-paragraph summary of what you recorded and why.
If a tool rejects a call, read the error, fix the arguments and call it again. Never stop without recording your result.
Amounts are in AED.`;

/** Fields stored in fils; agents see them in AED, renamed with an `Aed` suffix, to match bills. */
const FILS_FIELDS = new Set(["gross", "patientShare", "net", "amount", "billTotal", "paymentAmount", "payment", "annualUsed", "drugsUsed", "tariff"]);

function inAed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inAed);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => (FILS_FIELDS.has(key) && typeof item === "number" ? [`${key}Aed`, item / 100] : [key, inAed(item)])),
  );
}

function text(value: unknown): { output: [{ type: "text"; text: string }] } {
  return { output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(inAed(value), null, 2) }] };
}

function failure(message: string): { output: [{ type: "text"; text: string }]; isError: true } {
  return { output: [{ type: "text", text: message }], isError: true };
}

const fils = (aed: number): number => Math.round(aed * 100);

const ROLES: Record<AgentRole, RoleDefinition> = {
  enrollment: {
    instructions: `You are the enrollment agent. Decide whether an applicant can join ${PLAN.name}.
Eligibility: Dubai visa, monthly salary of AED ${PLAN.maxMonthlySalaryAed} or less, valid Emirates ID, not already a member.
Read the free-text health declaration and list every chronic or pre-existing condition it describes as ICD-10-CM category prefixes (for example E11 for type 2 diabetes, I10 for hypertension, J45 for asthma). Pre-existing conditions never block enrollment; they only start a ${PLAN.preExistingWaitingMonths}-month waiting period for members on their first UAE scheme.`,
    tools: (agent) => [
      defineTool({
        name: "get_application",
        description: "Read the enrollment application being processed.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const record = await agent.ledger().getEnrollment(agent.caseId());
          return record ? text(record.application) : failure("No application found");
        },
      }),
      defineTool({
        name: "find_member",
        description: "Look up an existing member by Emirates ID.",
        parameters: obj({ emirates_id: str() }),
        replay: "safe",
        async execute({ emirates_id }) {
          return text((await agent.ledger().findMemberByEmiratesId(emirates_id)) ?? "No member with this Emirates ID");
        },
      }),
      defineTool({
        name: "decide_enrollment",
        description: "Record the enrollment decision. Enrolling creates the member and policy.",
        parameters: obj({
          decision: oneOf(["enrolled", "declined"]),
          reason: str(),
          declared_conditions: arr(str(), { description: "ICD-10-CM category prefixes of declared chronic or pre-existing conditions" }),
        }),
        async execute({ decision, reason, declared_conditions }) {
          const ledger = agent.ledger();
          const record = await ledger.getEnrollment(agent.caseId());
          if (!record) return failure("No application found");
          if (record.decision !== "pending") return text(`Already decided: ${record.decision}`);
          const application = record.application;
          const problems: string[] = [];
          if (!/^784-\d{4}-\d{7}-\d$/.test(application.emiratesId)) problems.push("Emirates ID is not in the 784-YYYY-NNNNNNN-N format");
          if (application.visaEmirate !== "Dubai") problems.push("Visa is not issued in Dubai");
          if (application.monthlySalaryAed > PLAN.maxMonthlySalaryAed) problems.push(`Salary is above AED ${PLAN.maxMonthlySalaryAed}`);
          if (await ledger.findMemberByEmiratesId(application.emiratesId)) problems.push("Applicant is already a member");
          if (decision === "enrolled" && problems.length) return failure(`Cannot enroll: ${problems.join("; ")}. Decline instead.`);
          if (decision === "declined" && !problems.length) return failure("The applicant meets every eligibility rule; enroll them, or explain a rule they break.");
          let member: Member | null = null;
          if (decision === "enrolled") {
            const start = application.requestedStart;
            const end = new Date(`${start}T00:00:00Z`);
            end.setUTCFullYear(end.getUTCFullYear() + 1);
            end.setUTCDate(end.getUTCDate() - 1);
            member = await ledger.createMember({
              id: `SH-M-${application.applicationId.replace(/^APP-/, "")}`,
              emiratesId: application.emiratesId,
              name: application.name,
              dateOfBirth: application.dateOfBirth,
              visaEmirate: application.visaEmirate,
              monthlySalaryAed: application.monthlySalaryAed,
              planId: PLAN.id,
              policyStart: start,
              policyEnd: end.toISOString().slice(0, 10),
              firstUaeScheme: !application.previousUaeInsurance,
              declaredConditions: declared_conditions,
            });
          }
          await ledger.saveEnrollment({ ...record, decision, memberId: member?.id ?? null, reason });
          return text({ decision, member, reason });
        },
      }),
    ],
  },
  intake: {
    instructions: `You are the claims intake agent. A provider sent an eClaimLink Claim.Submission and a free-text itemized bill.
Match every bill item to the XML activity it pays for, total the bill, capture the presenting complaint and any GP e-Referral number, and list every mismatch between the bill and the XML (missing items, different amounts, items billed in one but not the other, totals that disagree).`,
    tools: (agent) => [
      defineTool({
        name: "get_submission",
        description: "Read the parsed Claim.Submission and the raw itemized bill text.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const record = await agent.ledger().getClaim(agent.caseId());
          return record ? text({ claim: record.claim, itemizedBill: record.bill }) : failure("No claim found");
        },
      }),
      defineTool({
        name: "record_extraction",
        description: "Record the structured extraction of the itemized bill.",
        parameters: obj({
          bill_items: arr(obj({ description: str(), activity_id: opt(str()), amount_aed: num() })),
          bill_total_aed: num(),
          presenting_complaint: str(),
          referral: opt(str()),
          mismatches: arr(str()),
        }),
        async execute(args) {
          await agent.ledger().setExtraction(agent.caseId(), {
            billItems: args.bill_items.map((item) => ({ description: item.description, activityId: item.activity_id, amount: fils(item.amount_aed) })),
            billTotal: fils(args.bill_total_aed),
            presentingComplaint: args.presenting_complaint,
            referral: args.referral,
            mismatches: args.mismatches,
          });
          return text("Recorded");
        },
      }),
    ],
  },
  coding: {
    instructions: `You are the medical coding reviewer. Check every diagnosis against the 2024 ICD-10-CM set and every activity against the 2024 CPT set (drugs use fictional formulary codes).
Look for: invalid or deleted codes, activities the diagnoses do not support, unbundling (a code billed alongside a code that already includes it), and upcoding (an E/M level above what the presenting complaint and services justify).
Record one finding per problem; record an info finding when everything is in order.`,
    tools: (agent) => [
      defineTool({
        name: "get_claim",
        description: "Read the claim and the intake extraction.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const record = await agent.ledger().getClaim(agent.caseId());
          return record ? text({ claim: record.claim, extraction: record.extraction }) : failure("No claim found");
        },
      }),
      defineTool({
        name: "lookup_icd10",
        description: "Look up an ICD-10-CM code in the 2024 code set.",
        parameters: obj({ code: str() }),
        replay: "safe",
        async execute({ code }) {
          const deleted = DELETED_ICD10CM[code];
          if (deleted) return text({ code, valid: false, deleted });
          const found = findDiagnosis(code);
          return text(found ? { valid: true, ...found } : { code, valid: false, note: "Not in Sahra's 2024 code subset" });
        },
      }),
      defineTool({
        name: "lookup_activity",
        description: "Look up an activity code by DHPO activity type (3 = CPT, 5 = drug).",
        parameters: obj({ type: num(), code: str() }),
        replay: "safe",
        async execute({ type, code }) {
          const found = findActivity(type as ActivityType, code);
          return text(found ? { valid: true, ...found } : { type, code, valid: false });
        },
      }),
      defineTool({
        name: "record_coding_review",
        description: "Record the coding findings.",
        parameters: obj({
          findings: arr(
            obj({
              activity_id: opt(str()),
              code: str(),
              severity: oneOf(["info", "warn", "error"]),
              kind: oneOf(["invalid_code", "diagnosis_mismatch", "unbundling", "upcoding", "other"]),
              message: str(),
            }),
          ),
          summary: str(),
        }),
        async execute({ findings, summary }) {
          await agent.ledger().setCoding(agent.caseId(), {
            findings: findings.map((finding) => ({ activityId: finding.activity_id, code: finding.code, severity: finding.severity, kind: finding.kind, message: finding.message })),
            summary,
          });
          return text("Recorded");
        },
      }),
    ],
  },
  adjudication: {
    instructions: `You are the coverage and adjudication agent for ${PLAN.name}. Decide, for every activity on the claim, whether to pay or deny it.
Use the plan rules, the hard-rule check, the coding findings and the intake mismatches. Deny unbundled components, activities the diagnoses do not support, and amounts the itemized bill does not support, each with the matching denial code.
Check the member's claim history: deny every line of a claim that repeats an already received claim (same provider, service date and codes) with SH-DUPL-01.
You never calculate amounts: propose_adjudication computes coinsurance, limits and payment, and refuses decisions that break a hard rule. If it refuses, fix the decisions and propose again.
Denial codes: ${Object.entries(DENIAL_CODES).map(([code, meaning]) => `${code} ${meaning}`).join("; ")}.`,
    tools: (agent) => [
      defineTool({
        name: "get_claim",
        description: "Read the claim, intake extraction, coding findings and the member.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const ledger = agent.ledger();
          const record = await ledger.getClaim(agent.caseId());
          if (!record) return failure("No claim found");
          const member = record.memberId ? await ledger.getMember(record.memberId) : null;
          const clinicians = await ledger.getClinicians([...new Set(record.claim.activities.map((activity) => activity.clinician))]);
          return text({ claim: record.claim, extraction: record.extraction, coding: record.coding, member, clinicians });
        },
      }),
      defineTool({
        name: "claim_history",
        description: "List the member's other claims, to spot duplicates.",
        parameters: obj({ member_id: str() }),
        replay: "safe",
        async execute({ member_id }) {
          return text(await agent.ledger().claimHistory(member_id, agent.caseId()));
        },
      }),
      defineTool({
        name: "get_coverage",
        description: "Read the plan's benefit rules, this member's benefit use this year, and which activities a hard rule forces to be denied.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const ledger = agent.ledger();
          const record = await ledger.getClaim(agent.caseId());
          if (!record) return failure("No claim found");
          const member = record.memberId ? await ledger.getMember(record.memberId) : null;
          const clinicians = await ledger.getClinicians([...new Set(record.claim.activities.map((activity) => activity.clinician))]);
          const accumulators = member ? await ledger.accumulators(member.id, record.id) : null;
          const base = { claim: record.claim, member: member ?? undefined, clinicians, accumulators: accumulators ?? { annualUsed: 0, drugsUsed: 0, physiotherapySessions: 0, consultationDates: [] } };
          return text({
            plan: { annualLimitAed: PLAN.annualLimit / 100, drugsAnnualLimitAed: PLAN.drugsAnnualLimit / 100, rules: PLAN.rules, exclusions: PLAN.excludedDiagnosisPrefixes },
            accumulators,
            hardRuleDenials: record.claim.activities.map((activity) => ({ activityId: activity.id, code: activity.code, mustDeny: requiredDenials(base, activity.id) })),
          });
        },
      }),
      defineTool({
        name: "propose_adjudication",
        description: "Propose pay or deny for every activity. Returns the computed remittance, or the hard rules your decisions break.",
        parameters: obj({
          lines: arr(
            obj({
              activity_id: str(),
              decision: oneOf(["pay", "deny"]),
              denial_code: opt(str()),
              reason: str(),
            }),
          ),
          summary: str(),
        }),
        async execute({ lines, summary }) {
          const ledger = agent.ledger();
          const record = await ledger.getClaim(agent.caseId());
          if (!record) return failure("No claim found");
          const member = record.memberId ? await ledger.getMember(record.memberId) : null;
          const clinicians = await ledger.getClinicians([...new Set(record.claim.activities.map((activity) => activity.clinician))]);
          const accumulators = member ? await ledger.accumulators(member.id, record.id) : { annualUsed: 0, drugsUsed: 0, physiotherapySessions: 0, consultationDates: [] };
          const remittance = computeRemittance({
            claim: record.claim,
            member: member ?? undefined,
            clinicians,
            accumulators,
            decisions: lines.map((line) => ({ activityId: line.activity_id, decision: line.decision, denialCode: line.denial_code, reason: line.reason })),
          });
          if (remittance.violations.length) return failure(`Refused:\n- ${remittance.violations.join("\n- ")}`);
          await ledger.setAdjudication(record.id, { lines: remittance.lines, totals: remittance.totals, summary });
          return text({ recorded: true, totals: remittance.totals, lines: remittance.lines });
        },
      }),
    ],
  },
  fraud: {
    instructions: `You are the fraud, waste and abuse reviewer. Look for: duplicate claims (same member, provider, service date and codes under a new claim ID), unusual visit frequency, providers whose coding is skewed to the highest E/M levels, identity mismatches, and bills that do not match the services.
Score each signal from 0 (no concern) to 1 (near certain). Recommend "pay" when nothing is wrong, "review" when a person should look closely, and "hold" for a likely duplicate or fraud. A person approves every claim before payment either way.`,
    tools: (agent) => [
      defineTool({
        name: "get_claim",
        description: "Read the claim with its extraction, coding review and proposed adjudication.",
        parameters: obj({}),
        replay: "safe",
        async execute() {
          const record = await agent.ledger().getClaim(agent.caseId());
          return record ? text({ claim: record.claim, extraction: record.extraction, coding: record.coding, adjudication: record.adjudication }) : failure("No claim found");
        },
      }),
      defineTool({
        name: "claim_history",
        description: "List the member's other claims.",
        parameters: obj({ member_id: str() }),
        replay: "safe",
        async execute({ member_id }) {
          return text(await agent.ledger().claimHistory(member_id, agent.caseId()));
        },
      }),
      defineTool({
        name: "provider_stats",
        description: "Summarize a provider's claims: count, codes billed and share of highest-level visits.",
        parameters: obj({ provider_id: str() }),
        replay: "safe",
        async execute({ provider_id }) {
          return text(await agent.ledger().providerStats(provider_id));
        },
      }),
      defineTool({
        name: "record_fraud_assessment",
        description: "Record the fraud assessment.",
        parameters: obj({
          signals: arr(
            obj({
              kind: oneOf(["duplicate", "frequency", "pattern", "identity", "other"]),
              score: num({ minimum: 0, maximum: 1 }),
              message: str(),
            }),
          ),
          score: num({ minimum: 0, maximum: 1 }),
          recommendation: oneOf(["pay", "review", "hold"]),
          summary: str(),
        }),
        async execute(args) {
          await agent.ledger().setFraud(agent.caseId(), args);
          return text("Recorded");
        },
      }),
    ],
  },
};

export function instructionsFor(role: AgentRole): string {
  return `${SHARED_RULES}\n\n${ROLES[role].instructions}`;
}

const CASE_KEY = "caseId";
const LEDGER_KEY = "ledger";

abstract class SahraAgent extends DurableObject<Env> {
  readonly role: AgentRole;
  readonly harness: PiHarness;
  readonly lifecycle: Lifecycle;
  readonly resolveModel: (choice: NonNullable<ModelChoice["model"]>) => Model<Api>;

  constructor(ctx: DurableObjectState, env: Env, role: AgentRole) {
    super(ctx, env);
    this.role = role;
    const ai = createAI({ binding: env.AI });
    const registry = createRegistry();
    // Workers have no process environment, so provider keys come from the Worker's secrets.
    const models = createModels({
      authContext: { env: async (name) => (name === "OPENROUTER_API_KEY" ? env.OPENROUTER_API_KEY || undefined : undefined), fileExists: async () => false },
    });
    models.setProvider(ai.provider);
    models.setProvider(openrouterProvider());
    this.resolveModel = (choice) => {
      const resolved = choice.provider === "cloudflare" ? ai(choice.id as Parameters<typeof ai>[0]) : models.getModel(choice.provider, choice.id);
      if (!resolved) throw new Error(`Unknown model ${choice.provider}/${choice.id}`);
      return resolved;
    };
    const choice = AGENT_MODELS[role].model;
    const model = choice ? this.resolveModel(choice) : undefined;
    this.harness = new PiHarness({
      harness: ({ storage, context, onWake }) => {
        registry.install({
          name: `sahra-${role}`,
          sections: [{ key: "preamble", render: () => instructionsFor(role), tag: false }],
          tools: ROLES[role].tools(this),
        });
        return Harness.open(storage, { models, registry, onWake, settings: { afterFailedRun: "withdraw" } }, context);
      },
      // Without a recorded model, sessions start with none and run() refuses before submitting.
      defaults: { ...(model ? { model } : {}), maxTurns: 12 },
    });
    this.lifecycle = Lifecycle.install(this).use(this.harness);
  }

  ledger() {
    return this.env.LEDGER.getByName(this.ctx.storage.kv.get<string>(LEDGER_KEY) ?? ledgerName());
  }

  caseId(): string {
    const id = this.ctx.storage.kv.get<string>(CASE_KEY);
    if (!id) throw new Error("No case assigned to this agent");
    return id;
  }

  /**
   * Runs the agent on its case once; a retried call with the same operation returns the first result.
   * `attempt` 1 and later are nudges in the same session, after the agent ended without recording.
   */
  // `override` is only for comparing Scout's candidates on the fixtures; it bypasses the recorded choice.
  async run(input: { caseId: string; runId?: string; prompt: string; override?: NonNullable<ModelChoice["model"]>; attempt?: number }): Promise<AgentRunResult> {
    const { caseId, override, attempt = 0 } = input;
    if (override) await this.harness.session().setModel(this.resolveModel(override));
    else if (!AGENT_MODELS[this.role].model) {
      return { role: this.role, model: null, status: "unanswered", reason: "no_model_decision: consult Scout and record the choice in MODEL-DECISIONS.md", entries: [] };
    }
    this.ctx.storage.kv.put(CASE_KEY, caseId);
    this.ctx.storage.kv.put(LEDGER_KEY, ledgerName(input.runId));
    const receipt = await this.harness.submit(input.prompt, { operationId: `${this.role}:${caseId}${attempt ? `:nudge-${attempt}` : ""}` });
    const result = await this.harness.wait(receipt.operationId);
    return {
      role: this.role,
      model: modelLabel({ model: override ?? AGENT_MODELS[this.role].model, decision: "" }),
      status: result.status,
      reason: result.reason,
      text: result.text,
      entries: await this.harness.messages(),
    };
  }
}

export class EnrollmentAgent extends SahraAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "enrollment");
  }
}

export class IntakeAgent extends SahraAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "intake");
  }
}

export class CodingAgent extends SahraAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "coding");
  }
}

export class AdjudicationAgent extends SahraAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "adjudication");
  }
}

export class FraudAgent extends SahraAgent {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, "fraud");
  }
}
