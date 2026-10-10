// A reviewed model/service-offer catalog for the hosted fictional comparison only.
// Scores are publisher-reported point estimates, not insurance-workload evaluations.
export const EVIDENCE_DATE = '2026-10-10';
export const PREFERENCES = [
  { value: 'default', label: 'Default · within your stack', note: 'Search all configured services; choose the lowest modeled cost among qualified replacements.' },
  { value: 'zdr', label: 'Bias ZDR models', note: 'Prefer confirmed ZDR endpoints. Eligibility alone does not establish account approval or enabled settings.' },
  { value: 'open', label: 'Bias open-weights models', note: 'Prefer open weights among qualifying replacements; otherwise keep the default qualified choice.' },
  { value: 'closed', label: 'No open-weights models', note: 'Require a closed-weight assignment for every workload. Unresolved workloads remain unassigned; qualifying choices stay visible in an incomplete plan.' },
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
const ossCard = 'https://arxiv.org/html/2508.10925v1';
const ossScores = (tool, capability, reasoning) => [
  metric('tools', 'τ-bench retail', tool, 'openai-oss-high-retail', ossCard, 'Table 3; high reasoning effort; developer function calling.'),
  metric('capabilities', 'MMLU', capability, 'openai-oss-high-mmlu', ossCard, 'Table 3; high reasoning effort, default system prompt, pass@1.'),
  metric('reasoning', 'GPQA Diamond · no tools', reasoning, 'openai-oss-high-gpqa', ossCard, 'Table 3; high reasoning effort, no tools, pass@1.'),
];
const dsCard = 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash';
const dsScores = (tool, capability, reasoning) => [
  metric('tools', 'AutomationBench', tool, 'deepseek41-automation', dsCard, 'Frontier instruct-model comparison; official scaffold, maximum reasoning effort, temperature 1, top-p .95.'),
  metric('capabilities', "Agent’s Last Exam", capability, 'deepseek41-ale', dsCard, 'Frontier instruct-model comparison; broad agent tasks, official scaffold, maximum reasoning effort.'),
  metric('reasoning', 'GPQA Diamond', reasoning, 'deepseek41-gpqa', dsCard, 'Frontier instruct-model comparison; pass@1, maximum reasoning effort. Published model scores, not endpoint measurements.'),
];
const qwenCard = 'https://huggingface.co/Qwen/Qwen3.6-27B';
const qwenScores = (tool, pass3, capability, reasoning) => [
  metric('tools', 'ClawEval · average', tool, 'qwen36-claw-avg', qwenCard, 'Qwen 3.6 27B release comparison; published model configurations.'),
  metric('tools', 'ClawEval · pass³', pass3, 'qwen36-claw-pass3', qwenCard, 'Same comparison, stricter repeated-task success. Both tool metrics must pass.'),
  metric('capabilities', 'MMMU-Pro', capability, 'qwen36-mmmupro', qwenCard, 'Vision benchmark; published Qwen 3.6 comparison configurations.'),
  metric('reasoning', 'GPQA Diamond', reasoning, 'qwen36-gpqa', qwenCard, 'Published Qwen 3.6 comparison configurations.'),
];
const cohortScores = (source, suite, names, values, settings) => ['tools', 'capabilities', 'reasoning'].map((axis, index) => metric(axis, names[index], values[index], `${suite}-${axis}`, source, settings));
const flashCard = 'https://huggingface.co/zai-org/GLM-5.3-Flash';
const flashScores = values => cohortScores(flashCard, 'glm53flash-release', ['AutomationBench v1.0.6', 'GDPval-AA v2', 'HLE · with tools'], values, 'Published release chart and footnotes; maximum effort; GDPval-AA rating, not percent.').map(item => item.axis === 'capabilities' ? { ...item, unit: ' rating' } : item);
const qwen38Card = 'https://huggingface.co/Qwen/Qwen3.8-27B';
const qwen38Scores = values => cohortScores(qwen38Card, 'qwen38-release', ['ClawEval-MM · average', 'IFBench', 'GPQA Diamond'], values, 'Qwen 3.8 model card comparison; published thinking configurations. ClawEval-MM is distinct from ClawEval.');
// The application-code profile screens generated SQL/Python used by the
// insurance product. These are application workers, not developer-harness usage.
// Keep publisher cohorts separate: LiveCodeBench v6 % is not LCB Pro Elo.
const glm47Card = 'https://huggingface.co/zai-org/GLM-4.7';
const glmCodeScores = values => cohortScores(glm47Card, 'glm47-application-code', ['τ²-bench', 'LiveCodeBench v6', 'GPQA Diamond'], values, 'GLM-4.7 release table; thinking enabled, preserved thinking for multi-turn tools; adjusted user prompts and fixed Airline domain. Published comparator configurations; not endpoint parity.');
const googleCodeScores = values => cohortScores(gemini, 'google-3flash-application-code', ['τ²-bench', 'LiveCodeBench Pro', 'GPQA Diamond'], values, 'December 2025 comparison: Gemini thinking, Sonnet 4.5 high/best available thinking. LCB Pro official leaderboard Elo; τ² fixed Airline, Gemini user simulator for Gemini and publisher-reported Sonnet score. Public comparison, not a controlled endpoint evaluation.').map(item => item.axis === 'capabilities' ? { ...item, unit: ' Elo' } : item);
const basetenPolicy = { confirmedZdr: true, policySource: 'https://www.baseten.co/security-practices/', endpointMode: 'Synchronous Model API; request/response logging off' };
const model = (id, name, provider, input, output, source, benchmarks = [], extra = {}) => ({ id, modelId: id, name, provider, input, output, source, benchmarks, creator: provider, origin: 'US', openWeights: false, outputType: 'text', confirmedZdr: false, ...extra });
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
  model('opus45', 'Claude Opus 4.5', 'Anthropic', 5, 25, anthropic, [...claudeScores(88.9, 70.6, 87), ...qwenScores(76.6, 59.6, 70.6, 87)]),
  model('sonnet46', 'Claude Sonnet 4.6', 'Anthropic', 3, 15, anthropic, claudeScores(91.7, 74.5, 89.9)),
  model('sonnet45', 'Claude Sonnet 4.5', 'Anthropic', 3, 15, anthropic, [...glmCodeScores([87.2, 64.0, 83.4]), ...googleCodeScores([87.2, 1418, 83.4])], { configuration: 'Thinking enabled; published comparison configurations' }),
  model('haiku45', 'Claude Haiku 4.5', 'Anthropic', 1, 5, anthropic),
  model('gemini25pro', 'Gemini 2.5 Pro', 'Google', 1.25, 10, google, googleScores(77.8, 68, 86.4)),
  model('gemini25flash', 'Gemini 2.5 Flash', 'Google', .3, 2.5, google, googleScores(79.5, 66.7, 82.8)),
  model('gemini3flash', 'Gemini 3 Flash Preview', 'Google', .5, 3, google, [...googleScores(90.2, 81.2, 90.4), ...googleCodeScores([90.2, 2316, 90.4])]),
  model('oss120', 'gpt-oss-120b', 'Groq', .15, .6, groq, ossScores(67.8, 90, 80.1), { creator: 'OpenAI', openWeights: true, configuration: 'High reasoning effort' }),
  model('oss20', 'gpt-oss-20b', 'Groq', .075, .3, groq, ossScores(54.8, 85.3, 71.5), { creator: 'OpenAI', openWeights: true, configuration: 'High reasoning effort' }),
  model('glm53', 'GLM-5.3', 'Baseten', 1.4, 4.4, baseten, dsScores(48.8, 28.5, 88.1), { creator: 'Z.ai', origin: 'CN', openWeights: true, ...basetenPolicy, configuration: 'Maximum reasoning effort' }),
  model('glm53flash', 'GLM-5.3-Flash', 'Baseten', .15, .5, baseten, flashScores([48.8, 1773, 55.3]), { creator: 'Z.ai', origin: 'CN', openWeights: true, ...basetenPolicy }),
  model('mistral35', 'Mistral Medium 3.5', 'Mistral', 1.5, 7.5, mistral, [], { origin: 'FR', openWeights: true, metadataSource: 'https://docs.mistral.ai/models/mistral-medium-3-5-26-04' }),
  model('mistral4', 'Mistral Small 4', 'Mistral', .15, .6, mistral, [], { origin: 'FR', openWeights: true }),
  model('oss120baseten', 'gpt-oss-120b', 'Baseten', .1, .5, baseten, ossScores(67.8, 90, 80.1), { modelId: 'oss120', creator: 'OpenAI', openWeights: true, ...basetenPolicy, configuration: 'High reasoning effort; same published checkpoint' }),
  model('deepseek41flash', 'DeepSeek V4.1 Flash', 'Baseten', .3, 1.2, baseten, dsScores(54.8, 31.8, 90.9), { creator: 'DeepSeek', origin: 'CN', openWeights: true, ...basetenPolicy, configuration: 'Maximum reasoning effort (100)' }),
  model('deepseek4pro0813', 'DeepSeek V4 Pro 0813', 'Baseten', 1.32, 3.96, baseten, [], { creator: 'DeepSeek', origin: 'CN', openWeights: true, ...basetenPolicy, metadataSource: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813' }),
  model('nemotron3ultra', 'Nemotron 3 Ultra', 'Baseten', .6, 2.4, baseten, cohortScores('https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16', 'nvidia-ultra-nemo', ['TauBench V3 · average', 'MMLU-Pro', 'GPQA · no tools'], [70.9, 86.8, 87.0], 'NVIDIA NeMo evaluation SDK; model-card configurations. TauBench V3 is not τ-bench or τ²-bench.'), { creator: 'NVIDIA', origin: 'US', openWeights: true, ...basetenPolicy, metadataSource: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16' }),
  model('glm52', 'GLM-5.2', 'Baseten', 1.4, 4.4, baseten, flashScores([26.2, 1504, 54.7]), { creator: 'Z.ai', origin: 'CN', openWeights: true, ...basetenPolicy, metadataSource: 'https://huggingface.co/zai-org/GLM-5.2' }),
  model('glm47', 'GLM-4.7', 'Baseten', .6, 2.2, 'https://www.baseten.co/library/glm-4-7/', [...cohortScores('https://huggingface.co/zai-org/GLM-4.7', 'glm47-release', ['τ²-bench', 'MMLU-Pro', 'GPQA Diamond'], [87.4, 84.3, 85.7], 'GLM-4.7 release configurations; preserved thinking, adjusted user prompts and fixed Airline domain for τ²-bench.'), ...glmCodeScores([87.4, 84.9, 85.7])], { creator: 'Z.ai', origin: 'CN', openWeights: true, ...basetenPolicy, configuration: 'Thinking enabled', metadataSource: 'https://huggingface.co/zai-org/GLM-4.7' }),
  model('qwen36', 'Qwen 3.6 · 27B', 'Groq', .6, 3, groq, [...qwenScores(72.4, 60.6, 75.8, 87.8), ...qwen38Scores([50.4, 69.1, 87.8])], { creator: 'Alibaba', origin: 'CN', openWeights: true, availability: 'Preview', metadataSource: qwenCard }),
  model('qwen38', 'Qwen 3.8 · 27B', 'Groq', .8, 4, groq, qwen38Scores([56.9, 79.5, 89.2]), { creator: 'Alibaba', origin: 'CN', openWeights: true, availability: 'Preview', metadataSource: 'https://huggingface.co/Qwen/Qwen3.8-27B' }),
  model('jev', 'Jev 1.13', 'TypeSafe', .042, 0, 'https://docs.typesafe.ai/models', [], { outputType: 'decision' }),
];
export const CONFIGURED_SERVICES = ['OpenAI', 'Anthropic', 'Google', 'Groq', 'Baseten', 'Mistral'];
const byId = id => CATALOG.find(item => item.id === id);
// Every workload is fictional application work. Names are plausible declarations,
// never represented as discoveries from a visitor's repository.
const APPLICATION_CODE_PROFILES = {
  'actuarial.queries': { input: 14000, output: 700 },
  'portfolio.reporting': { input: 18000, output: 900 },
  'claims.reconciliation': { input: 5000, output: 2000 },
  'reserves.analysis': { input: 6000, output: 2400 },
};
export const WORKLOADS = [
  ['claims.intake', 'Claim intake', 'gpt4o', ['parse_notice', 'extract_loss_date', 'normalize_address', 'link_policy', 'check_attachments', 'summarize_notice', 'prepare_case']],
  ['policy.extraction', 'Policy document extraction', 'gpt54', ['read_schedule', 'extract_limits', 'extract_deductibles', 'identify_endorsements', 'normalize_terms', 'link_sections', 'check_completeness']],
  ['coverage.review', 'Coverage review support', 'opus45', ['retrieve_wording', 'compare_endorsements', 'locate_exclusions', 'cite_conditions', 'summarize_scope', 'flag_ambiguity', 'prepare_review']],
  ['claims.correspondence', 'Claim correspondence', 'sonnet46', ['draft_acknowledgment', 'request_documents', 'summarize_progress', 'draft_follow_up', 'check_tone', 'cite_case_notes', 'prepare_handoff']],
  ['documents.verification', 'Document verification', 'gemini25pro', ['read_estimate', 'extract_line_items', 'match_invoices', 'check_totals', 'compare_versions', 'flag_missing_pages', 'prepare_evidence']],
  ['renewals.summary', 'Renewal preparation', 'gemini25flash', ['summarize_history', 'compare_schedules', 'list_changes', 'check_dates', 'extract_terms', 'prepare_brief', 'draft_reminder']],
  ['claims.tagging', 'Claim tagging', 'oss120', ['tag_document', 'label_channel', 'extract_reference', 'normalize_category', 'link_attachment', 'label_language', 'index_summary']],
  ['fraud.review', 'Fraud review support', 'glm53', ['summarize_signals', 'link_evidence', 'compare_statements', 'flag_inconsistency', 'build_timeline', 'prepare_case_note', 'route_to_reviewer']],
  ['broker.translation', 'Broker correspondence', 'mistral35', ['detect_language', 'translate_email', 'preserve_policy_terms', 'check_names', 'summarize_request', 'draft_reply', 'prepare_review']],
  ['claims.routing', 'Decision routing', 'gpt4o', ['route_notice', 'rank_queue', 'classify_document', 'score_completeness', 'flag_duplicates', 'choose_workflow', 'route_exception']],
  ['actuarial.queries', 'Actuarial query generation', 'sonnet45', ['read_schema', 'select_tables', 'generate_query', 'check_join_keys', 'validate_query', 'explain_result', 'prepare_review']],
  ['claims.reconciliation', 'Claim reconciliation scripts', 'sonnet45', ['read_line_items', 'normalize_columns', 'generate_transform', 'compare_totals', 'build_checks', 'explain_variance', 'prepare_review']],
  ['portfolio.reporting', 'Portfolio reporting queries', 'sonnet45', ['read_report_spec', 'map_dimensions', 'generate_query', 'check_aggregates', 'validate_periods', 'explain_result', 'prepare_report']],
  ['reserves.analysis', 'Reserve analysis scripts', 'sonnet45', ['read_triangle', 'normalize_periods', 'generate_calculation', 'check_assumptions', 'build_sensitivity', 'explain_projection', 'prepare_review']],
].map(([id, purpose, before, tasks]) => ({
  id, purpose, before: byId(before), configuredServices: CONFIGURED_SERVICES, tasks,
  benchmarkProfile: APPLICATION_CODE_PROFILES[id] ? 'Application code · tools, code generation, reasoning' : 'General application · tools, capabilities, reasoning',
  tokenProfile: APPLICATION_CODE_PROFILES[id] ?? null,
  requiredAxes: ['tools', 'capabilities', 'reasoning', ...(id === 'claims.routing' ? ['decisions'] : [])],
}));

export function modeledCost(model, usage) {
  return model && [model.input, model.output, usage.inputTokens, usage.outputTokens].every(value => Number.isFinite(value) && value >= 0)
    ? (model.input * usage.inputTokens + model.output * usage.outputTokens) / 1e6 : null;
}
export function assessReplacement(workload, candidate, usage) {
  const before = workload.before;
  const checks = workload.requiredAxes.flatMap(axis => axis === 'decisions' ? ['decisionAccuracy', 'calibration'] : [axis]).flatMap(axis => {
    const baselines = before.benchmarks.filter(item => item.axis === axis);
    const pairs = baselines.flatMap(a => candidate.benchmarks.filter(b => b.axis === axis && a.suite === b.suite && a.name === b.name && a.unit === b.unit && a.direction === b.direction).map(b => ({ a, b })));
    if (!pairs.length) return [{ axis, before: baselines[0] ?? null, after: candidate.benchmarks.find(item => item.axis === axis) ?? null, status: 'missing' }];
    // Check every matched metric, not the first passing score in a cohort.
    return pairs.map(({ a, b }) => {
      const comparable = Boolean(a.source && b.source && Number.isFinite(a.value) && Number.isFinite(b.value));
      const pass = comparable && (a.direction === 'lower' ? b.value <= a.value : b.value >= a.value);
      return { axis, before: a, after: b, status: !comparable ? 'missing' : pass ? 'pass' : 'regression' };
    });
  });
  const beforeCost = modeledCost(before, usage), afterCost = modeledCost(candidate, usage);
  const cheaper = beforeCost !== null && afterCost !== null && afterCost < beforeCost;
  // Only paired latency measurements with the same workload/configuration qualify.
  // No latency data is fabricated or inferred from token generation speed in this demo.
  const a = before.latency, b = candidate.latency;
  const faster = Boolean(a && b && a.suite && a.metric && a.suite === b.suite && a.metric === b.metric && a.source && b.source && Number.isFinite(a.value) && Number.isFinite(b.value) && b.value > 0 && b.value < a.value);
  const issues = [];
  if (!(workload.configuredServices ?? [before.provider]).includes(candidate.provider)) issues.push('Service is not configured in this environment');
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
  const assessments = (workload.candidates ?? CATALOG).filter(candidate => candidate.id !== workload.before.id).map(candidate => assessReplacement(workload, candidate, usage));
  const allowed = item => item.eligible && (preference !== 'closed' || item.candidate.openWeights === false);
  const byCost = (a, b) => (a.afterCost ?? Infinity) - (b.afterCost ?? Infinity) || a.candidate.id.localeCompare(b.candidate.id);
  const qualified = assessments.filter(allowed).sort(byCost);
  const defaultChoice = assessments.filter(item => item.eligible).sort(byCost)[0]?.candidate ?? workload.before;
  const selected = [...qualified].sort((a, b) => Number(matchesPreference(b.candidate, preference)) - Number(matchesPreference(a.candidate, preference)) || byCost(a, b))[0];
  const proposed = selected?.candidate ?? workload.before;
  const unresolved = preference === 'closed' && proposed.openWeights !== false;
  const after = unresolved ? null : proposed;
  const serviceChanged = Boolean(after && after.provider !== workload.before.provider);
  const modelChanged = Boolean(after && after.modelId !== workload.before.modelId);
  return {
    id: workload.id, purpose: workload.purpose, benchmarkProfile: workload.benchmarkProfile, tokenProfile: workload.tokenProfile, before: workload.before, after,
    changed: Boolean(after && selected), serviceChanged, modelChanged,
    checks: selected?.checks ?? [], assessments, qualifiedCount: qualified.length,
    preferenceMatched: Boolean(after && matchesPreference(after, preference)),
    preferenceChanged: Boolean(after && after.id !== defaultChoice.id),
    defaultChoice: defaultChoice.id, unresolved,
    reason: unresolved ? 'Needs a qualifying replacement. No reviewed closed-weight candidate passes every required check.'
      : selected ? `${modelChanged ? 'Selected benchmark scores match or improve' : 'Same model checkpoint and published benchmark scores; service changes'}; ${selected.cheaper ? 'modeled token cost is lower' : 'paired latency is lower'}.`
      : 'Baseline retained. No reviewed candidate passes every required check.',
  };
}
