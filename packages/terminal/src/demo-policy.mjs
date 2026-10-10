// A small, reviewed evidence catalog for the hosted fictional comparison only.
// Scores are publisher-reported point estimates, not insurance-workload evaluations.
export const EVIDENCE_DATE = '2026-10-10';
export const PREFERENCES = [
  { value: 'default', label: 'Default · within your stack', note: 'Use qualified replacements on the same configured services.' },
  { value: 'zdr', label: 'Bias ZDR models', note: 'Prefer confirmed ZDR endpoints. Eligibility alone does not establish account approval or enabled settings.' },
  { value: 'open', label: 'Bias open-weights models', note: 'Prefer open weights among qualifying replacements; otherwise keep the default qualified choice.' },
  { value: 'closed', label: 'No open-weights models', note: 'Exclude open weights from replacements. Unresolved workloads stay on their baseline and are flagged.' },
  { value: 'usa', label: 'Bias USA models', note: 'Prefer models from US developers. This does not specify hosting location or data residency.' },
  { value: 'china', label: 'Bias Chinese models', note: 'Prefer models from Chinese developers. This does not specify hosting location or data residency.' },
];
export const preferenceFor = value => PREFERENCES.find(item => item.value === value) ?? PREFERENCES[0];
const oa = 'https://openai.com/index/gpt-4-1/';
const claude = 'https://www-cdn.anthropic.com/bbd8ef16d70b7a1665f14f306ee88b53f686aa75/Claude%20Sonnet%204.6%20System%20Card.pdf';
const gemini = 'https://storage.googleapis.com/deepmind-media/gemini/gemini_3_flash_model_evaluation.pdf';
const metric = (axis, name, value, suite, source, settings) => ({ axis, name, value, suite, source, settings, unit: '%', direction: 'higher' });
const oaScores = (tool, capability, reasoning) => [
  metric('tools', 'τ-bench retail', tool, 'openai-4.1-tau-retail-gpt4o-user', oa, '5-run average; original GPT-4o user simulator; no custom tools or prompting.'),
  metric('capabilities', 'MMLU', capability, 'openai-4.1-mmlu', oa, 'OpenAI GPT-4.1 release comparison; GPT-4o snapshot 2024-11-20.'),
  metric('reasoning', 'AIME 2024', reasoning, 'openai-4.1-aime24', oa, 'OpenAI GPT-4.1 release comparison, AIME 2024.'),
];
const claudeScores = (tool, capability, reasoning) => [
  metric('tools', 'τ²-bench retail', tool, 'anthropic-sonnet46-tau2-retail', claude, 'Sonnet 4.6 system card §2.5; max effort, 10 trials for Sonnet; published Opus configuration.'),
  metric('capabilities', 'MMMU-Pro · no tools', capability, 'anthropic-sonnet46-mmmupro-notools', claude, 'Sonnet 4.6 system card Table 2.1.A; publisher model configurations.'),
  metric('reasoning', 'GPQA Diamond', reasoning, 'anthropic-sonnet46-gpqa', claude, 'Sonnet 4.6 system card §2.8; adaptive thinking, max effort for Sonnet; published Opus configuration.'),
];
const googleScores = (tool, capability, reasoning) => [
  metric('tools', 'τ²-bench', tool, 'google-3flash-tau2-fixed-airline', gemini, 'Gemini 3 Pro user simulator; fixed Airline domain; mean of Retail, Airline and Telecom.'),
  metric('capabilities', 'MMMU-Pro', capability, 'google-3flash-mmmupro', gemini, 'Thinking; mean of Standard and Vision settings; no tools.'),
  metric('reasoning', 'GPQA Diamond', reasoning, 'google-3flash-gpqa', gemini, 'Thinking; no tools; Google December 2025 comparison.'),
];
const model = (id, name, provider, input, output, source, benchmarks = [], extra = {}) => ({ id, name, provider, input, output, source, benchmarks, creator: provider, origin: 'US', openWeights: false, outputType: 'text', confirmedZdr: false, ...extra });
const openai = name => `https://developers.openai.com/api/docs/models/${name}`;
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const google = 'https://ai.google.dev/gemini-api/docs/pricing';
const groq = 'https://console.groq.com/docs/models';
const baseten = 'https://www.baseten.co/pricing/';
const mistral = 'https://docs.mistral.ai/inference/pricing';
export const CATALOG = [
  model('gpt4o', 'GPT-4o', 'OpenAI', 2.5, 10, openai('gpt-4o'), oaScores(60.3, 85.7, 13.1)),
  model('gpt41', 'GPT-4.1', 'OpenAI', 2, 8, openai('gpt-4.1'), oaScores(68, 90.2, 48.1)),
  model('gpt41mini', 'GPT-4.1 mini', 'OpenAI', .4, 1.6, openai('gpt-4.1-mini'), oaScores(55.8, 87.5, 49.6)),
  model('gpt54', 'GPT-5.4', 'OpenAI', 2.5, 15, openai('gpt-5.4')),
  model('gpt54mini', 'GPT-5.4 mini', 'OpenAI', .75, 4.5, openai('gpt-5.4-mini')),
  model('opus45', 'Claude Opus 4.5', 'Anthropic', 5, 25, anthropic, claudeScores(88.9, 70.6, 87)),
  model('sonnet46', 'Claude Sonnet 4.6', 'Anthropic', 3, 15, anthropic, claudeScores(91.7, 74.5, 89.9)),
  model('haiku45', 'Claude Haiku 4.5', 'Anthropic', 1, 5, anthropic),
  model('gemini25pro', 'Gemini 2.5 Pro', 'Google', 1.25, 10, google, googleScores(77.8, 68, 86.4)),
  model('gemini25flash', 'Gemini 2.5 Flash', 'Google', .3, 2.5, google, googleScores(79.5, 66.7, 82.8)),
  model('gemini3flash', 'Gemini 3 Flash Preview', 'Google', .5, 3, google, googleScores(90.2, 81.2, 90.4)),
  model('oss120', 'gpt-oss-120b', 'Groq', .15, .6, groq, [], { creator: 'OpenAI', openWeights: true }),
  model('oss20', 'gpt-oss-20b', 'Groq', .075, .3, groq, [], { creator: 'OpenAI', openWeights: true }),
  model('glm53', 'GLM-5.3', 'Baseten', 1.4, 4.4, baseten, [], { creator: 'Z.ai', origin: 'CN', openWeights: true, confirmedZdr: true, policySource: 'https://www.baseten.co/security-practices/' }),
  model('glm53flash', 'GLM-5.3-Flash', 'Baseten', .15, .5, baseten, [], { creator: 'Z.ai', origin: 'CN', openWeights: true, confirmedZdr: true, policySource: 'https://www.baseten.co/security-practices/' }),
  model('mistral35', 'Mistral Medium 3.5', 'Mistral', 1.5, 7.5, mistral, [], { origin: 'FR', openWeights: true, metadataSource: 'https://docs.mistral.ai/models/mistral-medium-3-5-26-04' }),
  model('mistral4', 'Mistral Small 4', 'Mistral', .15, .6, mistral, [], { origin: 'FR', openWeights: true }),
  model('jev', 'Jev 1.13', 'TypeSafe', .042, 0, 'https://docs.typesafe.ai/models', [], { outputType: 'decision' }),
];
const byId = id => CATALOG.find(item => item.id === id);
// Every workload is fictional application work. Names are plausible declarations,
// never represented as discoveries from a visitor's repository.
export const WORKLOADS = [
  ['claims.intake', 'Claim intake', 'gpt4o', ['gpt41', 'gpt41mini'], ['parse_notice', 'extract_loss_date', 'normalize_address', 'link_policy', 'check_attachments', 'summarize_notice', 'prepare_case']],
  ['policy.extraction', 'Policy document extraction', 'gpt54', ['gpt54mini'], ['read_schedule', 'extract_limits', 'extract_deductibles', 'identify_endorsements', 'normalize_terms', 'link_sections', 'check_completeness']],
  ['coverage.review', 'Coverage review support', 'opus45', ['sonnet46', 'haiku45'], ['retrieve_wording', 'compare_endorsements', 'locate_exclusions', 'cite_conditions', 'summarize_scope', 'flag_ambiguity', 'prepare_review']],
  ['claims.correspondence', 'Claim correspondence', 'sonnet46', ['haiku45'], ['draft_acknowledgment', 'request_documents', 'summarize_progress', 'draft_follow_up', 'check_tone', 'cite_case_notes', 'prepare_handoff']],
  ['documents.verification', 'Document verification', 'gemini25pro', ['gemini3flash', 'gemini25flash'], ['read_estimate', 'extract_line_items', 'match_invoices', 'check_totals', 'compare_versions', 'flag_missing_pages', 'prepare_evidence']],
  ['renewals.summary', 'Renewal preparation', 'gemini25flash', ['gemini3flash'], ['summarize_history', 'compare_schedules', 'list_changes', 'check_dates', 'extract_terms', 'prepare_brief', 'draft_reminder']],
  ['claims.tagging', 'Claim tagging', 'oss120', ['oss20'], ['tag_document', 'label_channel', 'extract_reference', 'normalize_category', 'link_attachment', 'label_language', 'index_summary']],
  ['fraud.review', 'Fraud review support', 'glm53', ['glm53flash'], ['summarize_signals', 'link_evidence', 'compare_statements', 'flag_inconsistency', 'build_timeline', 'prepare_case_note', 'route_to_reviewer']],
  ['broker.translation', 'Broker correspondence', 'mistral35', ['mistral4'], ['detect_language', 'translate_email', 'preserve_policy_terms', 'check_names', 'summarize_request', 'draft_reply', 'prepare_review']],
  ['claims.routing', 'Decision routing', 'gpt4o', ['gpt41', 'gpt41mini', 'jev'], ['route_notice', 'rank_queue', 'classify_document', 'score_completeness', 'flag_duplicates', 'choose_workflow', 'route_exception']],
].map(([id, purpose, before, candidates, tasks]) => ({ id, purpose, before: byId(before), candidates: candidates.map(byId), tasks, requiredAxes: ['tools', 'capabilities', 'reasoning', ...(id === 'claims.routing' ? ['decisions'] : [])] }));

export function modeledCost(model, usage) {
  return model && [model.input, model.output, usage.inputTokens, usage.outputTokens].every(value => Number.isFinite(value) && value >= 0)
    ? (model.input * usage.inputTokens + model.output * usage.outputTokens) / 1e6 : null;
}
export function assessReplacement(workload, candidate, usage) {
  const before = workload.before;
  const checks = workload.requiredAxes.flatMap(axis => axis === 'decisions' ? ['decisionAccuracy', 'calibration'] : [axis]).map(axis => {
    const a = before.benchmarks.find(item => item.axis === axis);
    const b = candidate.benchmarks.find(item => item.axis === axis);
    const comparable = Boolean(a && b && a.suite === b.suite && a.name === b.name && a.unit === b.unit && a.direction === b.direction && a.source && b.source && Number.isFinite(a.value) && Number.isFinite(b.value));
    const pass = comparable && (a.direction === 'lower' ? b.value <= a.value : b.value >= a.value);
    return { axis, before: a ?? null, after: b ?? null, status: !comparable ? 'missing' : pass ? 'pass' : 'regression' };
  });
  const beforeCost = modeledCost(before, usage), afterCost = modeledCost(candidate, usage);
  const cheaper = beforeCost !== null && afterCost !== null && afterCost < beforeCost;
  // Only paired latency measurements with the same workload/configuration qualify.
  // No latency data is fabricated or inferred from token generation speed in this demo.
  const a = before.latency, b = candidate.latency;
  const faster = Boolean(a && b && a.suite && a.metric && a.suite === b.suite && a.metric === b.metric && a.source && b.source && Number.isFinite(a.value) && Number.isFinite(b.value) && b.value > 0 && b.value < a.value);
  const issues = [];
  if (candidate.provider !== before.provider) issues.push('Outside this workload’s configured service');
  if (candidate.outputType !== before.outputType) issues.push('Different output contract; application adaptation required');
  if (checks.some(check => check.status === 'missing')) issues.push('Comparable benchmark evidence is incomplete');
  if (checks.some(check => check.status === 'regression')) issues.push('A required benchmark regresses');
  if (!cheaper && !faster) issues.push('No verified cost or latency improvement');
  return { candidate, checks, cheaper, faster, beforeCost, afterCost, issues, eligible: issues.length === 0 };
}
export function matchesPreference(model, preference) {
  return preference === 'zdr' ? model.confirmedZdr === true : preference === 'open' ? model.openWeights === true : preference === 'closed' ? model.openWeights === false : preference === 'usa' ? model.origin === 'US' : preference === 'china' ? model.origin === 'CN' : true;
}
export function selectReplacement(workload, usage, preference = 'default') {
  preference = preferenceFor(preference).value;
  const assessments = workload.candidates.map(candidate => assessReplacement(workload, candidate, usage));
  const eligible = assessments.filter(item => item.eligible && (preference !== 'closed' || item.candidate.openWeights === false));
  eligible.sort((a, b) => Number(matchesPreference(b.candidate, preference)) - Number(matchesPreference(a.candidate, preference)) || (a.afterCost ?? Infinity) - (b.afterCost ?? Infinity) || a.candidate.id.localeCompare(b.candidate.id));
  const selected = eligible[0];
  const after = selected?.candidate ?? workload.before;
  const unresolved = preference === 'closed' && after.openWeights !== false;
  return { id: workload.id, purpose: workload.purpose, before: workload.before, after, changed: Boolean(selected), checks: selected?.checks ?? [], assessments, preferenceMatched: Boolean(selected && matchesPreference(after, preference)), unresolved, reason: unresolved ? 'No qualifying closed replacement. Baseline retained; this workload does not meet the preference.' : selected ? `All required benchmark scores match or improve; ${selected.cheaper ? 'modeled token cost is lower' : 'paired latency is lower'}.` : 'Baseline retained. No candidate passes every required check.' };
}
