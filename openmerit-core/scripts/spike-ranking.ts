// Opt-in, not part of any check: measures one single-call task end to end with real model calls,
// on OpenRouter (OPENROUTER_API_KEY) and on OpenAI as an openai-compatible endpoint (OPENAI_API_KEY).
// A writer model writes cases from the bundle, then each candidate answers them with the bundle's tool
// mocked, and the label grader scores them. Spend is capped at $1 in total by the ledger.
//
//   node scripts/spike-ranking.ts
import { CandidateUnavailable, completeWith, createClient, createMeasure, labelMatch, MemoryLedger, writeCases, type EndpointConfig, type Ledger, type TaskBundle } from "../src/ranking/index.ts";

const openrouterKey = process.env.OPENROUTER_API_KEY, openaiKey = process.env.OPENAI_API_KEY;
if (!openrouterKey || !openaiKey) throw new Error("Set OPENROUTER_API_KEY and OPENAI_API_KEY");

// $1 in all: OpenMerit-paid (OpenRouter) and customer-paid (OpenAI) together.
const capped = new MemoryLedger({ openmerit: 0.6, customer: 0.4 });
// Every call's key, to count the calls that answered a mocked tool result (`call-1` and later).
const keys: string[] = [];
const ledger: Ledger = { reserve: input => { keys.push(input.key); return capped.reserve(input); }, settle: (key, cost) => capped.settle(key, cost), release: key => capped.release(key), spent: () => capped.spent() };
const endpoints: EndpointConfig[] = [
  { id: "openrouter", kind: "openrouter", apiKey: openrouterKey, funding: "openmerit" },
  { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: openaiKey, funding: "customer" },
];
const client = createClient(endpoints);

const bundle: TaskBundle = {
  task: "support ticket triage",
  description: "Routes a customer's support ticket to the queue that handles it. The model may look up the customer's latest order first.",
  current: { model: "openai/gpt-5-mini" },
  prompt: {
    system: "You route support tickets for an online shop. Answer with exactly one queue name: billing, technical, shipping or account. Use lookup_order when the ticket is about an order.",
    messages: [{ role: "user", content: "Ticket from {{customer}}:\n{{ticket}}" }],
  },
  tools: [{
    name: "lookup_order", description: "Looks up the customer's latest order.",
    parameters: { type: "object", properties: { customer: { type: "string" } }, required: ["customer"] },
    mockResult: { order: "A-1042", status: "shipped", carrier: "DHL", paid: true },
  }],
  output: { kind: "label", labels: ["billing", "technical", "shipping", "account"] },
  examples: [
    { input: { customer: "Ana", ticket: "I was charged twice for my last order." }, expected: "billing" },
    { input: { customer: "Ben", ticket: "The app crashes whenever I open the cart." }, expected: "technical" },
    { input: { customer: "Chen", ticket: "My parcel has said 'in transit' for nine days." }, expected: "shipping" },
  ],
};

const started = Date.now();
const writer = { endpoint: "openrouter", model: "openai/gpt-5-mini" };
const written = await writeCases({ bundle, complete: completeWith(client, writer, ledger, "spike/cases"), count: 9, labelCheck: true });
const afterWriting = await ledger.spent();
const ids = written.cases.map(item => item.id);
process.stdout.write(`Cases: ${written.cases.length} (${written.cases.filter(item => item.origin === "example").length} examples), ${written.dropped} dropped; label check offers ${written.question?.options?.length ?? 0}. Writer cost $${afterWriting.openmeritUsd.toFixed(5)}\n`);

const measure = createMeasure({ bundle, cases: written.cases, client, grader: labelMatch(), ledger, key: "spike" });
const candidates = [
  { endpoint: "openrouter", model: "openai/gpt-5-nano" },
  { endpoint: "openrouter", model: "google/gemini-2.5-flash-lite" },
  { endpoint: "openrouter", model: "openai/gpt-6-luna" },
  { endpoint: "openai", model: "gpt-5-nano" },
  { endpoint: "openai", model: "gpt-4.1-nano" },
];
const rows: Record<string, unknown>[] = [];
for (const candidate of candidates) {
  const prefix = `spike/0/${candidate.endpoint}/${candidate.model}/`;
  try {
    const result = await measure(candidate, ids);
    const toolRounds = keys.filter(key => key.startsWith(prefix) && !/\/call-0$/.test(key)).length;
    const failures = result.results.filter(item => item.failure).map(item => `${item.caseId}:${item.failure}`);
    rows.push({
      candidate: `${candidate.endpoint}/${candidate.model}`, passed: `${result.results.filter(item => item.pass).length}/${result.results.length}`,
      costUsd: Number(result.costUsd.toFixed(6)), estimate: result.costIsEstimate, meanLatencyMs: result.latencyMs === null ? null : Math.round(result.latencyMs), toolRounds, failures: failures.join(" ") || "",
    });
  } catch (error) {
    if (!(error instanceof CandidateUnavailable)) throw error;
    rows.push({ candidate: `${candidate.endpoint}/${candidate.model}`, passed: "unavailable", note: error.message.slice(0, 120) });
  }
}
console.table(rows);
const spent = await ledger.spent();
process.stdout.write(`Spent $${(spent.openmeritUsd + spent.customerUsd).toFixed(5)}: OpenRouter (OpenMerit-paid) $${spent.openmeritUsd.toFixed(5)}, OpenAI (customer-paid) $${spent.customerUsd.toFixed(5)}, in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
