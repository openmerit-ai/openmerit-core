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
  ] },
  { title: 'Using OpenMerit', pages: [
    { source: 'agent-evaluations.md', slug: 'agent-evaluations', title: 'Agent evaluations', documentationLabel: 'npm preview', description: 'Compare CLI revisions across Claude Code, Codex and OpenCode with Scout and repeated local checks.' },
  ] },
  { title: 'Reference', pages: [
    { source: 'commands.md', slug: 'commands', title: 'Commands', description: 'Inference Terminal, Scout setup and agent-evaluation commands.' },
    { source: 'pi-extension.md', slug: 'pi-extension', title: 'Scout for Pi', description: 'Native Scout setup and SDK embedding on current stable Pi.' },
    { source: 'troubleshooting.md', slug: 'troubleshooting', title: 'Troubleshooting', description: 'Diagnose Scout setup, credentials, discovery and host restrictions.' },
    { source: 'security.md', slug: 'security', title: 'Security & data', description: 'Understand credentials, authorization, local data, and evidence trust.' },
    { source: 'roadmap.md', slug: 'roadmap', title: 'Current limitations', description: 'Read the current readiness limits of the terminal, Scout setup and evaluations.' },
  ] },
  { title: 'Developers', pages: [
    { source: 'testing.md', slug: 'testing', title: 'Testing & validation', description: 'Distinguish implementation checks, runtime smoke tests, and product evidence.' },
  ] },
];

export const pages = groups.flatMap(group => group.pages.map(page => ({
  ...page, group: group.title, url: `/docs/${page.slug ? `${page.slug}/` : ''}`,
})));

// The founding memo is a standalone article, outside the product guides and search.
export const memo = {
  // The protected article builds from the recovered published memo.
  source: 'memo-published.md',
  url: '/memo/',
  protected: true,
  description: 'Optimum Inference for All. A memo by Lazim Aslam and Akhil Aryan on keeping model choices under review as the work and the models change.',
};
