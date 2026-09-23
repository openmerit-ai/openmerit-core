// Only these product documents are published. Design notes stay in the repository.
export const groups = [
  { title: 'Get started', pages: [
    { source: 'index.md', slug: '', title: 'Overview', description: 'Start comparing models against the work your product needs to do.' },
    { source: 'getting-started.md', slug: 'getting-started', title: 'Installation & setup', description: 'Install OpenMerit in Pi and establish your first product profile.' },
    { source: 'first-trial.md', slug: 'first-trial', title: 'Your first trial', description: 'Collect evidence, compare candidates, and validate a supervised model change.' },
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
