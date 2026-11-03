// These guides describe main; package releases and hosted deployments are separate.
export const documentationLabel = 'Main branch';
// Only these product documents are published. Design notes stay in the repository.
export const groups = [
  { title: 'Get started', pages: [
    { source: 'index.md', slug: '', title: 'Overview', description: 'Inspect application inference, consult Scout, and compare models with evidence.' },
    { source: 'getting-started.md', slug: 'getting-started', title: 'Installation & setup', description: 'Open the terminal or connect Scout to Claude Code and Pi.' },
    { source: 'inference-terminal.md', slug: 'inference-terminal', title: 'Inference Terminal', description: 'Inspect application declarations, recorded requests, services, and linked compute.' },
    { source: 'scout.md', slug: 'scout', documentationLabel: 'Hosted beta', githubSource: false, title: 'Scout · Beta', description: 'OpenMerit’s model search agent. Describe your task and get model recommendations.' },
    { source: 'scout-data-policy.md', slug: 'scout-data-policy', documentationLabel: 'Beta', githubSource: false, title: 'Scout data policy', description: 'Data use, sharing choices and deletion.' },
    { source: 'first-trial.md', slug: 'first-trial', title: 'Your first trial', description: 'Collect evidence, compare candidates, and validate a supervised model change.' },
  ] },
  { title: 'Using OpenMerit', pages: [
    { source: 'agent-evaluations.md', slug: 'agent-evaluations', title: 'Agent evaluations', documentationLabel: 'npm preview', description: 'Compare CLI revisions across Claude Code, Codex and OpenCode with Scout and repeated local checks.' },
    { source: 'metrics-and-evidence.md', slug: 'metrics-and-evidence', title: 'Metrics & evidence', description: 'Understand measurements, sample requirements, and evidence readiness.' },
    { source: 'lifecycle.md', slug: 'lifecycle', title: 'Comparisons & swaps', description: 'Follow the improvement lifecycle from baseline to post-swap evaluation.' },
    { source: 'automation.md', slug: 'automation', title: 'Automatic checks', description: 'Configure cadence, signals, and scheduling for model reassessment.' },
    { source: 'budgets.md', slug: 'budgets', title: 'Budgets & permissions', description: 'Understand evaluation costs, spending constraints, and automation permissions.' },
  ] },
  { title: 'Reference', pages: [
    { source: 'commands.md', slug: 'commands', title: 'Commands', description: 'Scout setup commands and historical coordinator command reference.' },
    { source: 'pi-extension.md', slug: 'pi-extension', title: 'Scout for Pi', description: 'Native Scout setup and SDK embedding on current stable Pi.' },
    { source: 'operations.md', slug: 'operations', title: 'Project files & logs', description: 'Find project state, audit events, evidence manifests, and recovery information.' },
    { source: 'troubleshooting.md', slug: 'troubleshooting', title: 'Troubleshooting', description: 'Diagnose Scout setup, credentials, discovery and host restrictions.' },
    { source: 'security.md', slug: 'security', title: 'Security & data', description: 'Understand credentials, authorization, local data, and evidence trust.' },
    { source: 'roadmap.md', slug: 'roadmap', title: 'Current limitations', description: 'Read the current readiness limits and next validation milestones.' },
  ] },
  { title: 'Developers', pages: [
    { source: 'architecture.md', slug: 'architecture', title: 'Architecture', description: 'How the protocol, coordinator, and harness adapters work together.' },
    { source: 'adapter-guide.md', slug: 'adapter-guide', title: 'Build an adapter', description: 'Connect another coding harness through the OpenMerit protocol and core.' },
    { source: 'pareto-spec.md', slug: 'pareto-spec', title: 'Pareto specification', description: 'The normative rules for readiness, feasibility, dominance, and frontier verification.' },
    { source: 'testing.md', slug: 'testing', title: 'Testing & validation', description: 'Distinguish implementation checks, runtime smoke tests, and product evidence.' },
  ] },
];

export const pages = groups.flatMap(group => group.pages.map(page => ({
  ...page, group: group.title, url: `/docs/${page.slug ? `${page.slug}/` : ''}`,
})));

// The founding memo is a standalone article, outside the product guides and search.
export const memo = {
  // Preserve the published article; memo.md remains the earlier editorial draft.
  source: 'memo-published.md',
  url: '/memo/',
  protected: true,
  description: 'Optimum Inference for All. A memo by Lazim Aslam and Akhil Aryan on keeping model choices under review as the work and the models change.',
};
