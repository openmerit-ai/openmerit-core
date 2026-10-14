// These guides describe main; package releases and hosted deployments are separate.
export const documentationLabel = 'Main branch';
// Only these product documents are published. Design notes stay in the repository.
export const groups = [
  { title: 'Get started', pages: [
    { source: 'index.md', slug: '', title: 'Overview', description: 'Inspect application inference and set up supervised model comparisons.' },
    { source: 'getting-started.md', slug: 'getting-started', title: 'Installation & setup', description: 'Open the standalone terminal or configure the separate Pi comparison workflow.' },
    { source: 'inference-terminal.md', slug: 'inference-terminal', title: 'Inference Terminal', description: 'Inspect application declarations, recorded requests, services, and linked compute.' },
    { source: 'first-trial.md', slug: 'first-trial', title: 'Your first trial', description: 'Collect evidence, compare candidates, and validate a supervised model change.' },
  ] },
  { title: 'Demos & recorded examples', pages: [
    { source: 'demo.md', slug: 'demo', title: 'Demos & samples', description: 'Explore fictional dashboards and distinguish them from recorded experiments.' },
    { source: 'interactive-demo.md', slug: 'interactive-demo', title: 'Interactive experiment', description: 'Understand the separately deployed delivery-resolution experiment, its checks, approvals, and limits.' },
    { source: 'demo-support.md', slug: 'demo-support', title: 'Support tickets', description: 'Compare three models on email-to-ticket extraction with exact-match grading.' },
    { source: 'demo-spam.md', slug: 'demo-spam', title: 'Spam filter · Jev', description: 'Compare a chat model with a typed-decision specialist on promotional spam.' },
    { source: 'demo-backfill.md', slug: 'demo-backfill', title: 'Backfill recovery', description: 'Follow a three-task agent through incident inspection, checkpoint lookup, and recovery planning.' },
    { source: 'demo-placement.md', slug: 'demo-placement', title: 'GPU placement', description: 'See how a three-task model route chooses a GPU pool under six constraints.' },
    { source: 'demo-fieldkit.md', slug: 'demo-fieldkit', title: 'Field kit · Six tasks', description: 'Explore a prepared six-model workflow spanning translation, vision, extraction, code, reasoning, and writing.' },
  ] },
  { title: 'Using OpenMerit', pages: [
    { source: 'metrics-and-evidence.md', slug: 'metrics-and-evidence', title: 'Metrics & evidence', description: 'Understand measurements, sample requirements, and evidence readiness.' },
    { source: 'lifecycle.md', slug: 'lifecycle', title: 'Comparisons & swaps', description: 'Follow the improvement lifecycle from baseline to post-swap evaluation.' },
    { source: 'automation.md', slug: 'automation', title: 'Automatic checks', description: 'Configure cadence, signals, and scheduling for model reassessment.' },
    { source: 'budgets.md', slug: 'budgets', title: 'Budgets & permissions', description: 'Understand evaluation costs, spending constraints, and automation permissions.' },
  ] },
  { title: 'Reference', pages: [
    { source: 'commands.md', slug: 'commands', title: 'Commands', description: 'The OpenMerit command reference for Pi.' },
    { source: 'operations.md', slug: 'operations', title: 'Project files & logs', description: 'Find project state, audit events, evidence manifests, and recovery information.' },
    { source: 'troubleshooting.md', slug: 'troubleshooting', title: 'Troubleshooting', description: 'Diagnose setup, evidence, scheduling, and lifecycle problems.' },
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
  source: 'memo.md',
  url: '/memo/',
  description: 'How can we accelerate the distribution of intelligence? A memo by Lazim on optimum inference and the direction of OpenMerit.',
};
