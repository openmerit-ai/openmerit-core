'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import {
  ArrowUpRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleHelp,
  FileText,
  GitBranch,
  PanelLeft,
  Download,
  Command,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
const infrastructureExamples = [
  {
    role: 'Routers',
    brands: [
      { name: 'OpenRouter', icon: 'openrouter.svg' },
      { name: 'Vercel', icon: 'vercel.svg' },
    ],
  },
  {
    role: 'Providers',
    brands: [
      { name: 'OpenAI', icon: 'openai.png' },
      { name: 'Anthropic', icon: 'anthropic.svg' },
      { name: 'SpaceXAI', icon: 'xai.svg' },
      { name: 'Mistral', icon: 'mistral-color.svg' },
    ],
  },
  {
    role: 'Inference clouds',
    brands: [
      { name: 'Together AI', icon: 'together.png' },
      { name: 'Fireworks AI', icon: 'fireworks.svg' },
    ],
  },
  {
    role: 'Endpoints',
    brands: [
      { name: 'Hugging Face', icon: 'huggingface.svg' },
      { name: 'Replicate', icon: 'replicate.svg' },
    ],
  },
];

const observabilityExamples = [
  {
    role: 'Evaluations',
    brands: [
      { name: 'Braintrust', icon: 'braintrust.png' },
      { name: 'Promptfoo', icon: 'promptfoo.png' },
    ],
  },
  {
    role: 'Tracing',
    brands: [
      { name: 'Langfuse', icon: 'langfuse.svg' },
      { name: 'Phoenix', icon: 'phoenix.png' },
    ],
  },
  {
    role: 'Experiments',
    brands: [
      { name: 'LangSmith', icon: 'langsmith.png' },
      { name: 'W&B Weave', icon: 'wandb.svg' },
    ],
  },
  {
    role: 'Monitoring',
    brands: [
      { name: 'Helicone', icon: 'helicone.svg' },
      { name: 'LangWatch', icon: 'langwatch.svg' },
    ],
  },
];

function RotatingCompany({
  group,
  order,
}: {
  group: (typeof infrastructureExamples)[number];
  order: number;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setInterval> | undefined;
    function sync() {
      clearInterval(timer);
      if (!motion.matches) {
        timer = setInterval(
          () => {
            if (!document.hidden)
              setIndex((current) => (current + 1) % group.brands.length);
          },
          2600 + order * 350,
        );
      }
    }
    sync();
    motion.addEventListener('change', sync);
    return () => {
      clearInterval(timer);
      motion.removeEventListener('change', sync);
    };
  }, [group, order]);
  const brand = group.brands[index];
  return (
    <span
      className="rotating-company"
      aria-label={`${group.role}: ${group.brands.map((item) => item.name).join(', ')}`}
    >
      <span className="rotating-brand" key={brand.name} aria-hidden="true">
        <Image
          src={`/brands/${brand.icon}`}
          alt=""
          width={22}
          height={22}
          unoptimized
        />
        <span>{brand.name}</span>
      </span>
      <small aria-hidden="true">{group.role}</small>
    </span>
  );
}

const tasks = [
  {
    name: 'Invoice extraction',
    subtitle: 'Extract 14 fields from scanned invoices.',
    constraints: [
      'Field accuracy ≥ 97%',
      'VAT accuracy ≥ 99%',
      'p95 latency < 4s',
    ],
    models: [
      ['Q', 'Qwen-VL 32B', '98.4%', '1.4s', '$0.41'],
      ['G', 'GPT mini', '98.7%', '2.1s', '$4.20'],
      ['C', 'Claude Sonnet', '98.8%', '2.8s', '$6.10'],
    ],
    outcome: 'Replace the incumbent',
    confidence: 'High',
    evidence:
      'Illustrative paired comparison: the quality delta and its confidence interval fall within the configured ±0.5pp equivalence margin. The recommended configuration clears every hard constraint.',
    next: 'Replace only after your deployment review.',
    choice: 'Qwen-VL 32B',
    reason:
      'All critical thresholds pass. A 0.4pp quality gap does not justify 14.9× higher inference cost.',
    saving: '93.3%',
    quality: '98.4%',
    latency: '1.4s',
  },
  {
    name: 'Support agent',
    subtitle: 'Answer product questions from a private knowledge base.',
    constraints: ['Factuality ≥ 95%', 'Citations required', 'p95 latency < 2s'],
    models: [
      ['Q', 'Qwen 14B + RAG', '96.2%', '0.9s', '$0.18'],
      ['L', 'Llama 8B + RAG', '94.1%', '0.6s', '$0.09'],
      ['C', 'Claude Sonnet', '96.5%', '1.8s', '$2.40'],
    ],
    outcome: 'Keep the incumbent',
    confidence: 'High',
    evidence:
      'In this scenario, Qwen 14B + RAG is already in production. The cheaper Llama configuration fails the factuality threshold; Claude adds cost without a material quality improvement.',
    next: 'Keep Qwen 14B + RAG. Reconsider when a qualified challenger appears.',
    choice: 'Qwen 14B + RAG',
    reason:
      'Qwen clears factuality and citation requirements. Claude adds 0.3pp of quality at 13.3× the cost.',
    saving: '92.5%',
    quality: '96.2%',
    latency: '0.9s',
  },
  {
    name: 'Repository bugfix',
    subtitle: 'Fix TypeScript bugs from an issue and repository context.',
    constraints: [
      'Tests and typecheck must pass',
      'No unrelated file changes',
      'Patch applies cleanly',
      'Zero regressions',
      'p95 latency < 90s',
    ],
    models: [
      ['G', 'GPT coding', '71.8%', '42s', '$1.82'],
      ['C', 'Claude coding', '72.4%', '58s', '$3.90'],
      ['Q', 'Qwen Coder 32B', '67.9%', '36s', '$0.44'],
    ],
    outcome: 'Insufficient evidence',
    confidence: 'Low',
    evidence:
      'The point estimates look promising, but the sample does not establish equivalence. The regression and typecheck evidence is incomplete. A cheaper run is not sufficient reason to change production.',
    next: 'Collect more representative bugfix cases and verify every hard constraint.',
    choice: 'No change recommended',
    reason:
      'The quality gap is small, but the evidence cannot establish equivalence or rule out regressions. Collect more cases before choosing.',
    saving: '53.3%',
    quality: '71.8%',
    latency: '42s',
  },
];
function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
export default function Home() {
  const [task, setTask] = useState(0);
  const d = tasks[task];
  function download() {
    const text = `# Model Decision Record\n\nIllustrative example — not a live benchmark.\n\nTask: ${d.name}\n${d.subtitle}\n\n## Requirements\n${d.constraints.map((x) => '- ' + x).join('\n')}\n\n## Decision\n${d.outcome}\nConfidence: ${d.confidence} (illustrative)\n\n## Recommendation\n${d.choice}\n${d.reason}\n\n## Evidence\n${d.evidence}\n\n## Next action\n${d.next}\n\n## Candidates\nModel | Quality | p95 | Cost / 1k\n${d.models.map((m) => m.slice(1).join(' | ')).join('\n')}\n`;
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/markdown' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'model-decision.md';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <header className="header">
        <a className="brand" href="#top">
          <Mark />
          OpenMerit
        </a>
        <nav aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#how-it-works">How it works</a>
          <a href="#agents">For agents</a>
          <a href="#evals">Free &amp; premium</a>
        </nav>
        <a className="button small" href="/evals">
          Start with an eval <ArrowUpRight size={14} />
        </a>
      </header>
      <main id="top">
        <section className="infra-hero" aria-labelledby="infra-title">
          <div className="infra-intro">
            <p className="eyebrow">MODEL DECISION INFRASTRUCTURE</p>
            <h1 id="infra-title">
              Your stack has models.
              <br />
              Give it <em>context to choose.</em>
            </h1>
            <p className="infra-copy">
              OpenMerit connects what runs your models with what measures them.
              <br className="desktop" /> Turn context from both into evidence
              for your next model decision.
            </p>
            <div className="actions">
              <a className="button primary" href="/evals">
                Start with an eval — free <ArrowUpRight size={16} />
              </a>
              <a className="button" href="#model-decision">
                See a model decision <ArrowDown size={14} />
              </a>
            </div>
          </div>
          <figure
            className="infra-diagram"
            aria-label="OpenMerit exchanges context with inference infrastructure and observability tools"
          >
            <div className="infra-group">
              <div className="infra-group-heading">
                <p className="eyebrow">INFERENCE INFRASTRUCTURE</p>
              </div>
              <div className="infra-nodes">
                {infrastructureExamples.map((group, order) => (
                  <RotatingCompany
                    key={group.role}
                    group={group}
                    order={order}
                  />
                ))}
              </div>
            </div>
            <div className="context-flows">
              <div>
                <span>Capabilities &amp; constraints</span>
                <ArrowRight aria-label="Into OpenMerit" />
              </div>
              <div>
                <ArrowLeft aria-label="From OpenMerit" />
                <span>Model &amp; config decisions</span>
              </div>
            </div>
            <div className="infra-core">
              <span className="infra-core-mark">
                <Mark />
              </span>
              <span className="infra-core-name">OpenMerit</span>
              <span className="infra-core-label">The model decision layer</span>
              <div>Compare. Decide. Explain.</div>
            </div>
            <div className="context-flows">
              <div>
                <span>Traces &amp; eval results</span>
                <ArrowLeft aria-label="Into OpenMerit" />
              </div>
              <div>
                <ArrowRight aria-label="From OpenMerit" />
                <span>Decision &amp; eval context</span>
              </div>
            </div>
            <div className="infra-group">
              <p className="eyebrow">OBSERVABILITY &amp; EVALS</p>
              <div className="infra-nodes observability-nodes">
                {observabilityExamples.map((group, order) => (
                  <RotatingCompany
                    key={group.brands[0].name}
                    group={group}
                    order={order + 1}
                  />
                ))}
              </div>
            </div>
            <figcaption>
              Context flows both ways. Your production requests stay on your
              infrastructure.
            </figcaption>
          </figure>
        </section>
        <section
          className="hero decision-section"
          id="model-decision"
          aria-labelledby="decision-title"
        >
          <div className="hero-top">
            <div>
              <p className="eyebrow hero-category">
                MODEL DECISION INFRASTRUCTURE
              </p>
              <h2 className="decision-heading" id="decision-title">
                Use the right model.
                <br />
                Prove <em>why.</em>
              </h2>
            </div>
            <div className="hero-right">
              <p>
                Benchmark models against your actual task. Compare quality,
                <br className="desktop" /> latency, cost, and deployment
                constraints. Give humans
                <br className="desktop" /> and coding agents a defensible answer
                to which one to use.
              </p>
              <div className="actions">
                <a className="button primary" href="/evals">
                  Start with an eval — free <ArrowUpRight size={16} />
                </a>
                <a className="button" href="#product">
                  See a model decision <ArrowDown size={14} />
                </a>
              </div>
            </div>
          </div>
          <div className="product-stage" id="product">
            <div className="workspace">
              <aside className="rail" aria-hidden="true">
                <span className="rail-logo">
                  <Mark />
                </span>
                <PanelLeft size={17} />
                <span className="rail-active">
                  <GitBranch size={18} />
                </span>
                <FileText size={17} />
                <span className="rail-bottom">om</span>
              </aside>
              <div className="workspace-main">
                <div className="workspace-bar">
                  <span>
                    Workspace <span className="slash">/</span> Decisions{' '}
                    <span className="slash">/</span> <strong>{d.name}</strong>
                  </span>
                  <span className="demo-label">Illustrative demo</span>
                </div>
                <div className="workspace-body">
                  <aside className="task-sidebar">
                    <p className="eyebrow">YOUR TASKS</p>
                    {tasks.map((t, i) => (
                      <button
                        key={t.name}
                        className={task === i ? 'task selected' : 'task'}
                        onClick={() => setTask(i)}
                        aria-pressed={task === i}
                      >
                        <FileText size={15} />
                        {t.name}
                        <span>↗</span>
                      </button>
                    ))}
                    <div className="task-note">
                      <span className="status-dot" />
                      Your infrastructure.
                      <br />
                      <span>Your credentials. Your choice.</span>
                    </div>
                  </aside>
                  <div className="report">
                    <div className="report-title">
                      <div>
                        <div className="report-meta">
                          DECISION RECORD <span> / 00{task + 1}</span>
                        </div>
                        <h2>{d.name}</h2>
                        <p>{d.subtitle}</p>
                      </div>
                      <button
                        className="export"
                        onClick={download}
                        aria-label="Download example decision record"
                      >
                        <Download size={15} />
                        <span>Export</span>
                      </button>
                    </div>
                    <Tabs defaultValue="decision">
                      <TabsList variant="line" className="report-tabs">
                        <TabsTrigger value="decision">Decision</TabsTrigger>
                        <TabsTrigger value="evidence">Evidence</TabsTrigger>
                        <TabsTrigger value="requirements">
                          Requirements
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="decision">
                        <div className="recommendation">
                          <span
                            className={
                              task === 2
                                ? 'check-icon uncertain-icon'
                                : 'check-icon'
                            }
                          >
                            {task === 2 ? (
                              <CircleHelp size={16} />
                            ) : (
                              <Check size={16} />
                            )}
                          </span>
                          <div>
                            <span className="recommend-label">
                              {d.outcome.toUpperCase()}
                            </span>
                            <h3>{d.choice}</h3>
                            <p>{d.reason}</p>
                          </div>
                          <span
                            className={
                              task === 2 ? 'passed uncertain' : 'passed'
                            }
                          >
                            Confidence: {d.confidence}
                          </span>
                        </div>
                        <div className="metrics">
                          <div>
                            <span>
                              {task === 2
                                ? 'Challenger quality'
                                : 'Task quality'}
                            </span>
                            <strong>
                              {d.quality}
                              <small>
                                {task === 2 ? 'point estimate' : 'qualified'}
                              </small>
                            </strong>
                          </div>
                          <div>
                            <span>p95 latency</span>
                            <strong>
                              {d.latency}
                              <small>within target</small>
                            </strong>
                          </div>
                          <div>
                            <span>
                              {task === 2
                                ? 'Potential cost reduction'
                                : 'Lower cost vs. Claude'}
                            </span>
                            <strong>
                              {d.saving}
                              <small>on this task</small>
                            </strong>
                          </div>
                        </div>
                        <div className="table-title">
                          Candidates compared{' '}
                          <span>Cost per 1,000 requests</span>
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              {[
                                'Model',
                                'Quality',
                                'p95 latency',
                                'Cost / 1k',
                              ].map((x) => (
                                <TableHead key={x}>{x}</TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {d.models.map((m, i) => (
                              <TableRow
                                key={m[1]}
                                className={
                                  i === 0 && task !== 2 ? 'winner' : ''
                                }
                              >
                                <TableCell>
                                  <span
                                    className={'model-symbol model-' + m[0]}
                                  >
                                    {m[0]}
                                  </span>
                                  {m[1]}{' '}
                                  {i === 0 && task !== 2 && (
                                    <Check size={13} className="inline-check" />
                                  )}
                                </TableCell>
                                {m.slice(2).map((v, j) => (
                                  <TableCell key={j}>{v}</TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TabsContent>
                      <TabsContent value="evidence">
                        <div className="detail-panel">
                          <p className="eyebrow">
                            THE REASON BEHIND THE RECOMMENDATION
                          </p>
                          <h3>
                            {d.outcome}. Confidence:{' '}
                            {d.confidence.toLowerCase()}.
                          </h3>
                          <p>{d.evidence}</p>
                          <p>
                            <strong>Next step.</strong> {d.next}
                          </p>
                          <div className="evidence-note">
                            These figures come from the supplied product concept
                            and illustrate the decision format. They are not
                            independently verified model benchmarks.
                          </div>
                        </div>
                      </TabsContent>
                      <TabsContent value="requirements">
                        <div className="detail-panel">
                          <p className="eyebrow">WHAT GOOD LOOKS LIKE</p>
                          <h3>{d.subtitle}</h3>
                          {d.constraints.map((c) => (
                            <div className="requirement" key={c}>
                              <Check size={16} />
                              {c}
                            </div>
                          ))}
                          <p className="evidence-note">
                            Define thresholds before running a comparison. Keep
                            the task specification alongside your application.
                          </p>
                        </div>
                      </TabsContent>
                    </Tabs>
                    <div className="report-foot">
                      <span>
                        <span className="status-dot" />{' '}
                        {task === 2
                          ? 'More evidence needed'
                          : 'Decision complete'}
                      </span>
                      <span>Evidence, not a leaderboard.</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="under-product">
            <p>
              Hosted, open, or internal.{' '}
              <span>Compare model configurations on your workload.</span>
            </p>
            <div className="execution-types">
              <span>Provider APIs</span>
              <span>Local models</span>
              <span>Private endpoints</span>
            </div>
          </div>
        </section>
        <section className="statement section" id="how-it-works">
          <p className="eyebrow">
            THE DECISION LAYER BETWEEN MODELS AND APPLICATIONS
          </p>
          <h2>
            A leaderboard can tell you
            <br />
            which model is impressive.
            <br />
            <span>
              We tell you which one
              <br />
              belongs in your product.
            </span>
          </h2>
          <div className="process">
            <article>
              <span className="step">01 / Define</span>
              <h3>Start with the job.</h3>
              <p>
                Describe the job, hard requirements, and costly failures. Define
                scorers and representative cases in a portable .eval.md file.
              </p>
            </article>
            <article>
              <span className="step">02 / Compare</span>
              <h3>Test what matters.</h3>
              <p>
                Find plausible models and configurations within your privacy,
                licensing, and deployment limits. Benchmark them with your own
                runner.
              </p>
            </article>
            <article>
              <span className="step">03 / Decide</span>
              <h3>Keep the reasoning.</h3>
              <p>
                Compare qualified options on quality, cost, and latency. Keep a
                record of the tradeoffs, confidence, and rejected
                alternatives—even when the answer is to wait.
              </p>
            </article>
          </div>
        </section>
        <section className="eval-section section" id="evals">
          <div className="eval-intro">
            <div>
              <p className="eyebrow">
                THE TEST IS FREE. THE DECISION IS THE PRODUCT.
              </p>
              <h2>
                Define what good means.
                <br />
                Keep it <em>without us.</em>
              </h2>
            </div>
            <p>
              Start with a task, not a model picker. Author the criteria, scorer
              definitions, and dataset plan. Your eval belongs in your
              repository.
            </p>
          </div>
          <div className="eval-layout">
            <div className="code-surface">
              <div className="code-header">
                <span>
                  <FileText size={14} /> support-routing.eval.md
                </span>
                <span>portable starter template</span>
              </div>
              <pre>{`# Support routing

## Objective
Classify support requests into 14 queues.

## Hard constraints
- valid JSON = 100%
- security false-negative rate < 0.5%
- billing false-negative rate < 1%
- p95 latency < 700ms

## Priorities
high-risk recall > accuracy > latency > cost

## Dataset plan
80 normal · 20 ambiguous · 20 high-risk
10 adversarial cases`}</pre>
              <div className="code-footer">
                <Download size={14} />
                <a href="/support-routing.eval.md" download>
                  Download the starter .eval.md
                </a>
              </div>
            </div>
            <div className="plan-boundary">
              <article>
                <span className="step">Free / Eval authoring</span>
                <h3>A useful test you can take with you.</h3>
                <p>
                  Task definitions, rubrics, scorer scaffolds, dataset
                  structure, local/manual execution, and portable exports.
                </p>
                <a
                  className="text-link"
                  href="/support-routing.eval.md"
                  download
                >
                  Start with the free template <ArrowUpRight size={16} />
                </a>
              </article>
              <article>
                <span className="step">
                  Premium / Decisions &amp; automation
                </span>
                <h3>Know what to use. Know when to change.</h3>
                <p>
                  Candidate discovery, automated comparisons, statistical
                  equivalence, Pareto analysis, and decision records. Continuous
                  re-evaluation, team approvals, and agent/CI workflows maintain
                  the decision over time.
                </p>
                <a className="text-link" href="#product">
                  Explore a decision example <ArrowUpRight size={16} />
                </a>
              </article>
            </div>
          </div>
        </section>
        <section className="agents section" id="agents">
          <div>
            <p className="eyebrow">CODING AGENTS ARE FIRST-CLASS USERS.</p>
            <h2>
              “Can we cut the cost
              <br />
              of this feature?”
              <br />
              <em>Give your agent evidence.</em>
            </h2>
            <p className="section-copy">
              The same task and decision primitives serve the web UI, MCP, CLI,
              and CI. Your agent identifies the model call, creates an eval, and
              brings back a structured recommendation for review.
            </p>
            <a className="text-link" href="/agent-spec.md" download>
              Read the MCP tool specification <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="code-surface">
            <div className="code-header">
              <span>
                <Command size={14} /> Repository → decision
              </span>
              <span>proposed MCP workflow</span>
            </div>
            <pre>
              <span className="code-comment">
                {'// Define the task and what success means'}
              </span>
              {'\n'}
              <span className="code-purple">task.analyze</span>
              {'\n'}
              <span className="code-purple">eval.create</span>
              {'\n\n'}
              <span className="code-comment">
                {'// Find configurations worth testing'}
              </span>
              {'\n'}
              <span className="code-purple">models.search</span>
              {'\n'}
              <span className="code-purple">benchmark.plan</span>
              {'\n\n'}
              <span className="code-comment">
                {'// Your runner executes. Keys stay local.'}
              </span>
              {'\n'}
              <span className="code-purple">benchmark.submit_results</span>
              {'\n'}
              <span className="code-purple">decision.recommend</span>
              {'\n'}
              <span className="code-purple">decision.explain</span>
            </pre>
            <div className="code-footer">
              <Check size={14} /> Recommendation, confidence, evidence, next
              actions.
            </div>
          </div>
        </section>
        <section className="principles section" id="principles">
          <p className="eyebrow">IN THE ARCHITECTURE. OUT OF THE HOT PATH.</p>
          <div className="principle-layout">
            <h2>
              The decision is ours.
              <br />
              The control stays <em>yours.</em>
            </h2>
            <div className="principle-list">
              <div>
                <h3>Your keys stay with you.</h3>
                <p>
                  A local or customer-controlled runner executes benchmarks.
                  Provider keys and private endpoint credentials stay in your
                  environment.
                </p>
              </div>
              <div>
                <h3>No routing. No token markup.</h3>
                <p>
                  Your application calls the chosen provider directly.
                  Production keeps running even if OpenMerit is unavailable.
                  There is no inference token markup.
                </p>
              </div>
              <div>
                <h3>Raw examples can stay local.</h3>
                <p>
                  Share metadata-only results when your privacy policy requires
                  it. Compare internal models without exposing raw inputs,
                  outputs, or endpoint credentials.
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="closing">
          <div>
            <p className="eyebrow">CHOOSE ON EVIDENCE.</p>
            <h2>
              Need a model?
              <br />
              Don’t <em>guess.</em>
            </h2>
          </div>
          <div>
            <p>Describe what your model needs to do.</p>
            <a className="button primary" href="/evals">
              Start with an eval — free <ArrowUpRight size={16} />
            </a>
          </div>
        </section>
      </main>
      <footer>
        <a className="brand" href="#top">
          <Mark />
          OpenMerit
        </a>
        <span>The model decision layer.</span>
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          Back to top ↑
        </a>
      </footer>
    </>
  );
}
