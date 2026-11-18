// `openmerit/engine`: the parts of Scout the local CLI and the cloud app share. Pure TypeScript with
// no Node.js-only imports at load time: the search over an ordered ladder, the catalogue types, the
// spend ledger, the guardrail resolver, the agent-eval rule and the redaction rules.
export { binarySearch, challengers, order, outward, CandidateUnavailable, SAMPLE_SIZE, FINALISTS, CHALLENGERS, type Rung, type Ranked, type Stage, type SearchResult, type ChallengerOptions } from "./search.ts";
export { pool, ladder, blendedPrice } from "./pool.ts";
export { CATALOGUE_FORMAT, catalogueIndex, requestPrice, type Catalogue, type CatalogueModel } from "./catalogue.ts";
export { parseCSV, parseEciScores, parseEciEstimates, ECI_ATTRIBUTION, ECI_SCORES_URL, type EciRow, type EciEstimate, type EciSource } from "./eci.ts";
export { MemoryLedger, settledUsd, expectedCost, sizeEstimate, readUsage, DEFAULT_OUTPUT_TOKENS, UNKNOWN_PRICE_RESERVATION_USD, type Ledger, type Funding, type Reservation, type ReserveResult, type Settlement } from "./ledger.ts";
export { resolveGuardrails, GUARDRAIL_KINDS, LEVELS, type Guardrails, type GuardrailKey, type GuardrailKind, type Level, type ActionPolicy, type Rejection, type ResolvedGuardrails } from "./guardrails.ts";
export { checkAgent, type AgentEvalInput, type AgentEvalResult, type AgentOption, type AgentRun, type AgentScore, type Switch } from "./agent-eval.ts";
export { redact } from "./redact.ts";
