import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { WorkflowStep } from "cloudflare:workers";

test("every scored agent trace carries its experiment tag without changing final-item linkage", async (t) => {
  // Exercise the real workflows and OTLP exporter, with no platform or model calls.
  const source = new URL("../src/workflow.ts", import.meta.url).href;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    const stub = specifier === "cloudflare:workers" ? "export class WorkflowEntrypoint {} export class DurableObject {}"
      : specifier === "cloudflare:workflows" ? "export class NonRetryableError extends Error {}"
      : specifier === "./agents.ts" && context.parentURL === source ? "export const instructionsFor = () => 'Fictional test instructions';" : null;
    return stub ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const { ClaimFlow, EnrollmentFlow } = await import("../src/workflow.ts");
  const spans: Array<{ name: string; attributes: Array<{ key: string; value: { stringValue?: string; arrayValue?: { values: { stringValue: string }[] } } }> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert(String(input).startsWith("https://langfuse.example/"));
    if (String(input).endsWith("/otel/v1/traces")) {
      const body = JSON.parse(String(init?.body)) as { resourceSpans: { scopeSpans: { spans: typeof spans }[] }[] };
      spans.push(...body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
    }
    return Response.json({});
  });
  const agent = { getByName: () => ({ run: async () => ({ entries: [], status: "completed", text: "Fictional result" }) }) };
  const env = { LANGFUSE_PUBLIC_KEY: "pk-lf-fictional", LANGFUSE_SECRET_KEY: "sk-lf-fictional", LANGFUSE_BASE_URL: "https://langfuse.example", LANGFUSE_ENVIRONMENT: "test",
    LEDGER: { getByName: () => ({ getClaim: async () => ({ extraction: {}, coding: {}, adjudication: {}, fraud: {} }), requestApproval: async () => {}, getEnrollment: async () => ({ decision: "enrolled" }) }) },
    INTAKE_AGENT: agent, CODING_AGENT: agent, ADJUDICATION_AGENT: agent, FRAUD_AGENT: agent, ENROLLMENT_AGENT: agent };
  const stop = new Error("Stop before human approval");
  const step = { do: async (_name: string, ...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
    sleep: async () => { assert.fail("Unexpected workflow sleep"); },
    sleepUntil: async () => { assert.fail("Unexpected workflow sleepUntil"); },
    waitForEvent: async () => { throw stop; } } as WorkflowStep;
  for (const id of ["experiment-alpha", "experiment-beta", undefined]) {
    spans.length = 0;
    const experiment = id ? { id, name: "Fictional experiment", datasetId: "fictional-dataset", metadata: {} } : undefined;
    const shared = { runId: "different-workflow-run-id", experiment };
    const claim = Object.create(ClaimFlow.prototype) as InstanceType<typeof ClaimFlow>;
    const enrollment = Object.create(EnrollmentFlow.prototype) as InstanceType<typeof EnrollmentFlow>;
    for (const flow of [claim, enrollment]) Object.defineProperty(flow, "env", { value: env });
    await assert.rejects(claim.run({ payload: { claimId: "fictional-claim", ...shared }, timestamp: new Date(), instanceId: "claim-test", workflowName: "playground-claim-flow" }, step), error => error === stop);
    await enrollment.run({ payload: { applicationId: "fictional-application", ...shared }, timestamp: new Date(), instanceId: "enrollment-test", workflowName: "playground-enrollment-flow" }, step);
    assert.deepEqual(spans.map(span => span.name), ["extract-claim", "review-coding", "adjudicate-claim", "assess-fraud", "assess-enrollment"]);
    for (const span of spans) {
      const tags = span.attributes.find(a => a.key === "langfuse.trace.tags")?.value.arrayValue?.values.map(v => v.stringValue) ?? [];
      assert.equal(tags[0], "sahra-health");
      assert.deepEqual(tags.filter(tag => tag.startsWith("experiment:")), id ? [`experiment:${id}`] : []);
      const linked = span.attributes.find(a => a.key === "langfuse.experiment.id")?.value.stringValue;
      assert.equal(linked, id && ["assess-fraud", "assess-enrollment"].includes(span.name) ? id : undefined);
    }
  }
});
