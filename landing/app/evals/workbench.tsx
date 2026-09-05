'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  FlaskConical,
  Layers,
  FileText,
  ShieldCheck,
  Database,
  SlidersHorizontal,
  Play,
  Send,
  CheckCircle2,
  AlertTriangle,
  X,
  Loader2,
  Sparkles,
  BookOpen,
  History,
  Link2,
  Trash2,
  Code2,
  Eye,
  ExternalLink,
} from 'lucide-react';
import {
  EvalSpec,
  Case,
  Scorer,
  createEval,
  templates,
  starterCases,
  validateEval,
  serialize,
  parse,
  readRows,
  mapRows,
  score,
  summarize,
  calibrate,
  importResults,
  type Destination,
  type EvalCase,
  type Observation,
} from '@openmerit/core';
import {
  destinationReadiness,
  scorerCompatibility,
} from '@openmerit/integrations/browser';

type Tab = 'brief' | 'criteria' | 'cases' | 'graders' | 'review' | 'publish';
type Conn = {
  id: string;
  name: string;
  destination: Destination;
  projectId: string;
  baseUrl: string;
};
type DiagnosticReport = {
  valid: boolean;
  diagnostics: Array<{
    severity: 'error' | 'warning' | 'info';
    message: string;
    action: string;
  }>;
};
type Deployment = {
  id: string;
  resourceName: string;
  status: string;
  url?: string;
};
type DeploymentPlan = { changes: string[] };
type GenerationJob = {
  id: string;
  status: 'queued' | 'running' | 'failed' | 'complete';
  error?: string;
  proposal?: EvalSpec;
};
const destinations: {
  id: Destination;
  name: string;
  letter: string;
  detail: string;
}[] = [
  { id: 'local', name: 'Local / Git', letter: '⌘', detail: 'Your environment' },
  {
    id: 'langfuse',
    name: 'Langfuse',
    letter: 'L',
    detail: 'Traces & experiments',
  },
  {
    id: 'braintrust',
    name: 'Braintrust',
    letter: 'B',
    detail: 'Datasets & scorers',
  },
  {
    id: 'langsmith',
    name: 'LangSmith',
    letter: 'L',
    detail: 'Runs & evaluations',
  },
];
const nav: { id: Tab; label: string; icon: typeof FileText }[] = [
  { id: 'brief', label: 'Task brief', icon: FileText },
  { id: 'criteria', label: 'Success criteria', icon: ShieldCheck },
  { id: 'cases', label: 'Dataset', icon: Database },
  { id: 'graders', label: 'Graders', icon: SlidersHorizontal },
  { id: 'review', label: 'Validate & test', icon: FlaskConical },
  { id: 'publish', label: 'Export & deploy', icon: Send },
];
async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = (await response.json()) as {
    ok: boolean;
    data: T;
    error?: string;
  };
  if (!response.ok || !result.ok) throw Error(result.error ?? 'Request failed');
  return result.data;
}
function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pretty(value: unknown) {
  return value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
}
function jsonOrText(value: string) {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function StudioMark() {
  return (
    <span className="studio-logo-mark" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}

export default function Workbench() {
  const [spec, setSpec] = useState<EvalSpec | null>(null),
    [tab, setTab] = useState<Tab>('brief'),
    [destination, setDestination] = useState<Destination>('local'),
    [brief, setBrief] = useState(''),
    [family, setFamily] = useState<EvalSpec['family']>('classification'),
    [busy, setBusy] = useState(''),
    [notice, setNotice] = useState(''),
    [loaded, setLoaded] = useState(false),
    [signedIn, setSignedIn] = useState(false),
    [saved, setSaved] = useState<EvalSpec[]>([]),
    [proposal, setProposal] = useState<EvalSpec | null>(null),
    [connections, setConnections] = useState<Conn[]>([]),
    [showConnect, setShowConnect] = useState(false),
    [showHistory, setShowHistory] = useState(false),
    [editingCase, setEditingCase] = useState<EvalCase | null>(null),
    [rawEditor, setRawEditor] = useState(false),
    [rawText, setRawText] = useState(''),
    [importFile, setImportFile] = useState<{
      text: string;
      format: 'csv' | 'jsonl';
    } | null>(null),
    [mapping, setMapping] = useState({
      input: 'input',
      expected: 'expected',
      output: 'output',
    }),
    [observations, setObservations] = useState<Observation[]>([]),
    [report, setReport] = useState<DiagnosticReport | null>(null),
    [deployPlan, setDeployPlan] = useState<DeploymentPlan | null>(null),
    [deployments, setDeployments] = useState<Deployment[]>([]),
    [connectionId, setConnectionId] = useState(''),
    [remoteImport, setRemoteImport] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null),
    resultRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      const draft = localStorage.getItem('openmerit:draft');
      if (draft) setSpec(EvalSpec.parse(JSON.parse(draft)));
      const history = localStorage.getItem('openmerit:versions');
      if (history)
        setSaved(JSON.parse(history).map((s: unknown) => EvalSpec.parse(s)));
    } catch {
      setNotice(
        'A saved draft could not be loaded. Import its JSON to recover it.',
      );
    }
    setLoaded(true);
    api<unknown>('workspace/me')
      .then(() => {
        setSignedIn(true);
        api<Conn[]>('workspace/connections')
          .then(setConnections)
          .catch(() => {});
        api<Deployment[]>('workspace/deployments')
          .then(setDeployments)
          .catch(() => {});
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (loaded && spec) {
      try {
        localStorage.setItem('openmerit:draft', JSON.stringify(spec));
      } catch {
        setNotice('Browser storage is full. Export your eval to keep a copy.');
      }
    }
  }, [spec, loaded]);
  useEffect(() => {
    setReport(null);
    setDeployPlan(null);
    setObservations([]);
  }, [spec, destination]);
  const health = spec ? validateEval(spec) : null;
  const readiness = spec ? destinationReadiness(spec, destination) : null;
  function update(patch: Partial<EvalSpec>) {
    setSpec((s) =>
      s ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s,
    );
  }
  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }
  function start() {
    const next = createEval(family, brief || undefined);
    setSpec(next);
    setTab('brief');
  }
  async function generate() {
    if (!spec) return;
    await act('Designing your eval', async () => {
      let result = await api<GenerationJob>('workspace/generate', {
        description: spec.description,
        family: spec.family,
        current: spec,
      });
      while (result.status === 'queued' || result.status === 'running') {
        await new Promise((r) => setTimeout(r, 1500));
        result = await api<GenerationJob>('workspace/jobs/' + result.id);
      }
      if (result.status === 'failed') throw Error(result.error);
      setProposal(EvalSpec.parse(result.proposal));
    });
  }
  async function save() {
    if (!spec) return;
    await act('Saving version', async () => {
      const version = Math.max(
        spec.version,
        ...saved.filter((s) => s.id === spec.id).map((s) => s.version + 1),
      );
      const snapshot = EvalSpec.parse({ ...spec, version });
      if (signedIn) await api<unknown>('workspace/evals', snapshot);
      const next = [snapshot, ...saved];
      localStorage.setItem('openmerit:versions', JSON.stringify(next));
      setSaved(next);
      setSpec({ ...snapshot, version: version + 1 });
      setNotice(
        `Version ${version} saved${signedIn ? ' to your workspace' : ' in this browser'}. You’re now editing the next version.`,
      );
    });
  }
  async function bundle() {
    if (!spec) return;
    await act('Preparing export', async () => {
      const response = await fetch('/api/eval/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, destination }),
      });
      if (!response.ok) throw Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${spec.family}-${destination}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  function localTest() {
    if (!spec) return;
    const next = spec.cases
      .filter((c) => c.output !== undefined)
      .map((c) => ({
        caseId: c.id,
        trial: 1,
        output: c.output,
        scores: spec.scorers
          .filter((s) =>
            s.requirementIds.some((id) => c.requirementIds.includes(id)),
          )
          .map((s) => score(s, c.output, c.expected)),
      }));
    setObservations(next);
    if (!next.length)
      setNotice(
        'Add observed outputs to your cases, or import local runner results.',
      );
  }
  const chosen = destinations.find((d) => d.id === destination)!;
  return (
    <div className="studio">
      <aside className="studio-sidebar">
        <Link className="studio-brand" href="/">
          <StudioMark />
          OpenMerit<span className="studio-beta">BETA</span>
        </Link>
        <div className="studio-space">
          <span className="studio-avatar">P</span>
          <div>
            Personal workspace<small>Free plan · Eval Studio</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <div className="studio-section-label">WORKSPACE</div>
        <button className="studio-nav active" onClick={() => setTab('brief')}>
          <Layers size={17} />
          Eval Studio
          <span className="studio-dot" />
        </button>
        <button className="studio-nav" onClick={() => setShowHistory(true)}>
          <History size={17} />
          Saved versions<span className="studio-count">{saved.length}</span>
        </button>
        <button className="studio-nav" onClick={() => setShowConnect(true)}>
          <Link2 size={17} />
          Connections<span className="studio-count">{connections.length}</span>
        </button>
        <div className="studio-sidebar-line" />
        <div className="studio-section-label">YOUR EVAL</div>
        {nav.map(({ id, label, icon: Icon }, i) => (
          <button
            key={id}
            disabled={!spec}
            className={`studio-nav ${spec && tab === id ? 'selected' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={16} />
            {label}
            <span className="studio-nav-number">0{i + 1}</span>
          </button>
        ))}
        <div className="studio-sidebar-bottom">
          <div className="studio-portable">
            <span className="studio-green-dot" /> Yours, everywhere.
            <p>
              Open format. Your infrastructure.
              <br />
              No lock-in.
            </p>
          </div>
          <a
            className="studio-nav"
            href="https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={16} />
            Evaluation field guide
            <ArrowUpRight size={14} />
          </a>
          {!signedIn ? (
            <Link className="studio-nav" href="/api/auth/login">
              <span className="studio-avatar small">↗</span>Sign in to sync &
              connect
            </Link>
          ) : (
            <div className="studio-nav">
              <span className="studio-avatar small">P</span>Personal workspace
              <Check size={14} />
            </div>
          )}
        </div>
      </aside>
      <div className="studio-body">
        <header className="studio-topbar">
          <div className="studio-breadcrumb">
            Workspace
            <ChevronRight size={13} />
            <span>Eval Studio</span>
            {spec && (
              <>
                <ChevronRight size={13} />
                <span>{spec.name}</span>
              </>
            )}
          </div>
          <div className="studio-top-actions">
            <span className="studio-free">FREE TOOL</span>
            <a
              href="https://github.com"
              className="studio-icon-link"
              aria-label="GitHub"
              target="_blank"
              rel="noreferrer"
            >
              <Code2 size={17} />
            </a>
          </div>
        </header>
        {notice && (
          <output className="studio-notice">
            <AlertTriangle size={16} />
            <span>{notice}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice('')}
            >
              <X size={16} />
            </button>
          </output>
        )}
        {!spec ? (
          <main className="studio-onboarding">
            <div className="studio-eyebrow">
              <span className="studio-green-dot" /> GOOD MODELS START WITH GOOD
              TESTS
            </div>
            <h1>
              What does <em>good</em>
              <br />
              look like for your AI?
            </h1>
            <p className="studio-lead">
              Turn your task into a rigorous eval.
              <br />
              Write it here. Run it wherever you work.
            </p>
            <div className="studio-start-card">
              <div className="studio-start-label">
                <FileText size={16} />
                Describe your task<span>01 / START WITH THE JOB</span>
              </div>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="We classify support emails into 14 queues. Missing a security issue is much worse than an ordinary routing mistake. The output must be JSON…"
              />
              <div className="studio-start-bottom">
                <select
                  aria-label="Task family"
                  value={family}
                  onChange={(e) => setFamily(e.target.value as typeof family)}
                >
                  {templates.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="studio-btn primary" onClick={start}>
                  Create an eval
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
            <div className="studio-platform-strip">
              <span>DESIGNED TO TRAVEL</span>
              {destinations.map((d) => (
                <button
                  type="button"
                  className={destination === d.id ? 'chosen' : ''}
                  key={d.id}
                  onClick={() => setDestination(d.id)}
                  aria-pressed={destination === d.id}
                >
                  <span className={'studio-platform-logo ' + d.id}>
                    {d.letter}
                  </span>
                  {d.name}
                </button>
              ))}
            </div>
            <div className="studio-template-heading">
              <h2>Start with a proven structure</h2>
              <span>10 task-specific templates</span>
            </div>
            <div className="studio-template-grid">
              {templates.map((t, i) => (
                <button
                  key={t.id}
                  className="studio-template"
                  onClick={() => {
                    setSpec(createEval(t.id));
                    setTab('brief');
                  }}
                >
                  <span className="studio-template-number">
                    {String(i + 1).padStart(2, '0')} /
                  </span>
                  <h3>
                    {t.name}
                    <ArrowUpRight size={16} />
                  </h3>
                  <p>{t.description}</p>
                </button>
              ))}
            </div>
            <p className="studio-footnote">
              Templates are starting points. Your examples and judgment make the
              eval yours.
            </p>
          </main>
        ) : (
          <>
            <div className="studio-eval-heading">
              <div>
                <div className="studio-eyebrow">
                  EVAL WORKBENCH <span>/</span>{' '}
                  {templates
                    .find((t) => t.id === spec.family)
                    ?.name.toUpperCase()}
                </div>
                <input
                  aria-label="Eval name"
                  className="studio-title-input"
                  value={spec.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
                <div className="studio-eval-meta">
                  <span className="studio-draft-badge">
                    Draft · v{spec.version}
                  </span>
                  <span>Autosaved in this browser</span>
                  <span>•</span>
                  <span>{spec.cases.length} cases</span>
                </div>
              </div>
              <div className="studio-heading-buttons">
                <button className="studio-btn" onClick={save} disabled={!!busy}>
                  <History size={15} />
                  Save version
                </button>
                <button
                  className="studio-btn primary"
                  onClick={() => setTab('publish')}
                >
                  Export eval
                  <ArrowUpRight size={16} />
                </button>
              </div>
            </div>
            <div className="studio-step-tabs">
              {nav.map(({ id, label }, i) => (
                <button
                  className={tab === id ? 'current' : ''}
                  key={id}
                  onClick={() => setTab(id)}
                >
                  <span>{i + 1}</span>
                  {label}
                </button>
              ))}
            </div>
            <div className="studio-work-grid">
              <main className="studio-main">
                {tab === 'brief' && (
                  <>
                    <Section
                      eyebrow="01 / DEFINE THE JOB"
                      title="Start with the task."
                      description="A useful eval measures what matters to your users. Be specific about the job, the inputs, and the cost of a mistake."
                    />
                    <div className="studio-card">
                      <Label
                        title="Task description"
                        hint="What does your application need to do?"
                      />
                      <textarea
                        className="studio-textarea tall"
                        value={spec.description}
                        onChange={(e) =>
                          update({
                            description: e.target.value,
                            task: { ...spec.task, objective: e.target.value },
                          })
                        }
                      />
                      <div className="studio-two-col">
                        <div>
                          <Label title="Inputs" />
                          <textarea
                            className="studio-textarea"
                            value={spec.task.inputDescription}
                            onChange={(e) =>
                              update({
                                task: {
                                  ...spec.task,
                                  inputDescription: e.target.value,
                                },
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label title="Expected outputs" />
                          <textarea
                            className="studio-textarea"
                            value={spec.task.outputDescription}
                            onChange={(e) =>
                              update({
                                task: {
                                  ...spec.task,
                                  outputDescription: e.target.value,
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                    <div className="studio-ai-card">
                      <span className="studio-ai-icon">
                        <Sparkles size={21} />
                      </span>
                      <div>
                        <h3>Make the first draft sharper</h3>
                        <p>
                          AI proposes criteria, graders, and a dataset plan. You
                          review every change.
                        </p>
                      </div>
                      <button
                        className="studio-btn"
                        disabled={!!busy}
                        onClick={generate}
                      >
                        {busy === 'Designing your eval' ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Sparkles size={14} />
                        )}
                        Refine with AI
                      </button>
                    </div>
                    {spec.task.questions.length > 0 && (
                      <div className="studio-card">
                        <Label
                          title="Questions worth answering"
                          hint="Resolve these before treating the eval as ready."
                        />
                        {spec.task.questions.map((q, i) => (
                          <div className="studio-question" key={i}>
                            <span>?</span>
                            <p>{q}</p>
                            <button
                              className="studio-text-button"
                              onClick={() =>
                                update({
                                  task: {
                                    ...spec.task,
                                    questions: spec.task.questions.filter(
                                      (_, j) => i !== j,
                                    ),
                                  },
                                })
                              }
                            >
                              Resolved
                              <Check size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="studio-next">
                      <span>Next, define what success means.</span>
                      <button
                        className="studio-btn"
                        onClick={() => setTab('criteria')}
                      >
                        Success criteria
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </>
                )}
                {tab === 'criteria' && (
                  <>
                    <Section
                      eyebrow="02 / MAKE SUCCESS MEASURABLE"
                      title="What must go right?"
                      description="Separate quality goals from hard requirements. A critical failure should never disappear inside an average."
                      action={
                        <button
                          className="studio-btn"
                          onClick={() =>
                            update({
                              requirements: [
                                ...spec.requirements,
                                {
                                  id: 'req-' + crypto.randomUUID().slice(0, 8),
                                  text: 'New requirement',
                                  severity: 'quality',
                                  minimumPassRate: 0.95,
                                },
                              ],
                            })
                          }
                        >
                          <Plus size={15} />
                          Add criterion
                        </button>
                      }
                    />
                    {spec.requirements.map((r, i) => (
                      <div className="studio-card studio-criterion" key={r.id}>
                        <div className="studio-card-top">
                          <span className={'studio-pill ' + r.severity}>
                            {r.severity === 'critical'
                              ? 'CRITICAL FAILURE'
                              : r.severity === 'hard'
                                ? 'HARD REQUIREMENT'
                                : 'QUALITY GOAL'}
                          </span>
                          <span className="studio-mono">{r.id}</span>
                        </div>
                        <textarea
                          aria-label={`Criterion ${i + 1}`}
                          className="studio-criterion-input"
                          value={r.text}
                          onChange={(e) =>
                            update({
                              requirements: spec.requirements.map((x, j) =>
                                j === i ? { ...x, text: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <div className="studio-criterion-settings">
                          <label>
                            Severity
                            <select
                              value={r.severity}
                              onChange={(e) =>
                                update({
                                  requirements: spec.requirements.map((x, j) =>
                                    j === i
                                      ? {
                                          ...x,
                                          severity: e.target
                                            .value as typeof r.severity,
                                        }
                                      : x,
                                  ),
                                })
                              }
                            >
                              <option value="quality">Quality</option>
                              <option value="hard">Hard requirement</option>
                              <option value="critical">Critical</option>
                            </select>
                          </label>
                          <label>
                            Minimum pass rate
                            <div className="studio-input-unit">
                              <input
                                aria-label="Minimum pass rate"
                                type="number"
                                min={0}
                                max={100}
                                value={r.minimumPassRate * 100}
                                onChange={(e) =>
                                  update({
                                    requirements: spec.requirements.map(
                                      (x, j) =>
                                        j === i
                                          ? {
                                              ...x,
                                              minimumPassRate: Math.max(
                                                0,
                                                Math.min(
                                                  1,
                                                  Number(e.target.value) / 100,
                                                ),
                                              ),
                                            }
                                          : x,
                                    ),
                                  })
                                }
                              />
                              <span>%</span>
                            </div>
                          </label>
                          <div className="studio-criterion-links">
                            <span>
                              <SlidersHorizontal size={13} />
                              {
                                spec.scorers.filter((s) =>
                                  s.requirementIds.includes(r.id),
                                ).length
                              }{' '}
                              graders
                            </span>
                            <span>
                              <Database size={13} />
                              {
                                spec.cases.filter((c) =>
                                  c.requirementIds.includes(r.id),
                                ).length
                              }{' '}
                              cases
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="studio-muted-note">
                      <ShieldCheck size={17} />
                      <p>
                        A 100% observed pass rate is a result on your sample,
                        not a guarantee about future traffic.
                      </p>
                    </div>
                  </>
                )}
                {tab === 'cases' && (
                  <>
                    <Section
                      eyebrow="03 / TEST THE REAL WORKLOAD"
                      title="Good cases beat more cases."
                      description="Bring representative examples, include failure modes, and hold back cases your graders have never seen."
                      action={
                        <div className="studio-row">
                          <button
                            className="studio-btn"
                            onClick={() => fileRef.current?.click()}
                          >
                            <Upload size={15} />
                            Import
                          </button>
                          <button
                            className="studio-btn primary"
                            onClick={() =>
                              setEditingCase(
                                Case.parse({
                                  id: 'case-' + crypto.randomUUID().slice(0, 8),
                                  input: '',
                                  requirementIds: spec.requirements.map(
                                    (r) => r.id,
                                  ),
                                  provenance: { source: 'manual' },
                                }),
                              )
                            }
                          >
                            <Plus size={15} />
                            Add case
                          </button>
                        </div>
                      }
                    />
                    <input
                      ref={fileRef}
                      type="file"
                      hidden
                      accept=".csv,.jsonl,.json,.md"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f)
                          void act('Reading import', async () => {
                            const text = await f.text();
                            if (
                              f.name.endsWith('.md') ||
                              f.name.endsWith('.json')
                            ) {
                              setSpec(parse(text));
                              setNotice('Eval imported.');
                            } else {
                              const format = f.name.endsWith('.csv')
                                ? 'csv'
                                : 'jsonl';
                              readRows(text, format);
                              setImportFile({ text, format });
                            }
                          });
                        e.target.value = '';
                      }}
                    />
                    <div className="studio-stats">
                      <Stat label="Total cases" value={spec.cases.length} />
                      <Stat
                        label="Real / curated"
                        value={
                          spec.cases.filter(
                            (c) => c.provenance.source !== 'synthetic',
                          ).length
                        }
                      />
                      <Stat
                        label="Calibration"
                        value={
                          spec.cases.filter((c) => c.split === 'calibration')
                            .length
                        }
                      />
                      <Stat
                        label="Held out"
                        value={
                          spec.cases.filter((c) => c.split === 'holdout').length
                        }
                      />
                    </div>
                    {!spec.cases.length ? (
                      <div className="studio-empty">
                        <div className="studio-empty-icon">
                          <Database size={28} />
                        </div>
                        <h3>Your dataset starts here.</h3>
                        <p>
                          Import real examples, add a case manually,
                          <br />
                          or explore an illustrative starter case.
                        </p>
                        <button
                          className="studio-btn"
                          onClick={() => update({ cases: starterCases(spec) })}
                        >
                          <Plus size={15} />
                          Add a starter case
                        </button>
                        <small>
                          Synthetic examples are labeled and never treated as
                          production evidence.
                        </small>
                      </div>
                    ) : (
                      <div className="studio-table-wrap">
                        <table className="studio-table">
                          <thead>
                            <tr>
                              <th>CASE / INPUT</th>
                              <th>SOURCE</th>
                              <th>SPLIT</th>
                              <th>COVERAGE</th>
                              <th>ACTIONS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {spec.cases.map((c, i) => (
                              <tr key={c.id}>
                                <td>
                                  <button
                                    className="studio-case-link"
                                    aria-label={`Edit ${c.id}`}
                                    onClick={() => setEditingCase(c)}
                                  >
                                    <span className="studio-case-num">
                                      {String(i + 1).padStart(2, '0')}
                                    </span>
                                    <div>
                                      <strong>{c.id}</strong>
                                      <p>{pretty(c.input).slice(0, 90)}</p>
                                    </div>
                                  </button>
                                </td>
                                <td>
                                  <span
                                    className={
                                      'studio-source ' +
                                      (c.provenance.source === 'synthetic'
                                        ? 'synthetic'
                                        : '')
                                    }
                                  >
                                    {c.provenance.source}
                                  </span>
                                </td>
                                <td>
                                  <select
                                    aria-label={`Split for ${c.id}`}
                                    value={c.split}
                                    onChange={(e) =>
                                      update({
                                        cases: spec.cases.map((x) =>
                                          x.id === c.id
                                            ? {
                                                ...x,
                                                split: e.target
                                                  .value as typeof c.split,
                                              }
                                            : x,
                                        ),
                                      })
                                    }
                                  >
                                    <option>development</option>
                                    <option>calibration</option>
                                    <option>holdout</option>
                                  </select>
                                </td>
                                <td>{c.requirementIds.length} criteria</td>
                                <td>
                                  <button
                                    className="studio-icon-button"
                                    aria-label={`Delete ${c.id}`}
                                    onClick={() =>
                                      update({
                                        cases: spec.cases.filter(
                                          (x) => x.id !== c.id,
                                        ),
                                      })
                                    }
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <button
                      className="studio-text-button"
                      onClick={() => setRemoteImport(true)}
                    >
                      <Link2 size={14} />
                      Import a selected platform dataset or trace
                      <ArrowUpRight size={14} />
                    </button>
                    <div className="studio-card">
                      <Label
                        title="Dataset collection plan"
                        hint="Suggested slices to collect. Counts are starting points, not statistical guarantees."
                      />
                      <div className="studio-segments">
                        {spec.datasetPlan.segments.map((s) => (
                          <div key={s.name}>
                            <span>{s.name}</span>
                            <span className="studio-mono">
                              ~{s.targetCount} cases
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {tab === 'graders' && (
                  <>
                    <Section
                      eyebrow="04 / TEST YOUR TESTS"
                      title="Grade with evidence."
                      description="Use code for objective checks and calibrated judges for nuanced judgments. Every grader should have clear passing and failing examples."
                      action={
                        <button
                          className="studio-btn"
                          onClick={() =>
                            update({
                              scorers: [
                                ...spec.scorers,
                                Scorer.parse({
                                  id:
                                    'scorer-' + crypto.randomUUID().slice(0, 8),
                                  name: 'New grader',
                                  kind: 'exact',
                                  requirementIds: [spec.requirements[0].id],
                                }),
                              ],
                            })
                          }
                        >
                          <Plus size={15} />
                          Add grader
                        </button>
                      }
                    />
                    {spec.scorers.map((s, i) => {
                      const compatibility = scorerCompatibility(s, destination);
                      return (
                        <div className="studio-card" key={s.id}>
                          <div className="studio-card-top">
                            <span className="studio-pill neutral">
                              {s.kind === 'judge'
                                ? 'LLM JUDGE'
                                : 'DETERMINISTIC'}
                            </span>
                            <span
                              className={`studio-compat ${compatibility.mode}`}
                              title={compatibility.reason}
                            >
                              <span className="studio-green-dot" />
                              {compatibility.label}
                            </span>
                          </div>
                          <input
                            className="studio-grader-title"
                            aria-label={`Grader name ${i + 1}`}
                            value={s.name}
                            onChange={(e) =>
                              update({
                                scorers: spec.scorers.map((x, j) =>
                                  i === j ? { ...x, name: e.target.value } : x,
                                ),
                              })
                            }
                          />
                          <div className="studio-two-col">
                            <label className="studio-field">
                              Scoring method
                              <select
                                value={s.kind}
                                onChange={(e) =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      i === j
                                        ? {
                                            ...x,
                                            kind: e.target
                                              .value as typeof s.kind,
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              >
                                {[
                                  'exact',
                                  'normalized',
                                  'contains',
                                  'regex',
                                  'numeric',
                                  'set',
                                  'json-schema',
                                  'judge',
                                  'custom',
                                ].map((k) => (
                                  <option key={k}>{k}</option>
                                ))}
                              </select>
                            </label>
                            <label className="studio-field">
                              Pass threshold
                              <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={s.threshold}
                                onChange={(e) =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      i === j
                                        ? {
                                            ...x,
                                            threshold: Math.max(
                                              0,
                                              Math.min(
                                                1,
                                                Number(e.target.value),
                                              ),
                                            ),
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              />
                            </label>
                          </div>
                          <Label title="Measures" />
                          <div className="studio-checks">
                            {spec.requirements.map((r) => (
                              <label key={r.id}>
                                <input
                                  type="checkbox"
                                  checked={s.requirementIds.includes(r.id)}
                                  onChange={(e) =>
                                    update({
                                      scorers: spec.scorers.map((x, j) =>
                                        i === j
                                          ? {
                                              ...x,
                                              requirementIds: e.target.checked
                                                ? [...x.requirementIds, r.id]
                                                : x.requirementIds.filter(
                                                    (id) => id !== r.id,
                                                  ),
                                            }
                                          : x,
                                      ),
                                    })
                                  }
                                />
                                {r.text}
                              </label>
                            ))}
                          </div>
                          {s.kind === 'judge' ? (
                            <>
                              <Label title="Judge instructions" />
                              <textarea
                                className="studio-textarea tall"
                                value={s.rubric ?? ''}
                                onChange={(e) =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      i === j
                                        ? { ...x, rubric: e.target.value }
                                        : x,
                                    ),
                                  })
                                }
                              />
                              <Label title="Score anchors" />
                              <div className="studio-anchors">
                                {s.anchors.map((a, j) => (
                                  <div key={j}>
                                    <span>{a.score}</span>
                                    <input
                                      aria-label={`Anchor ${a.score}`}
                                      value={a.description}
                                      onChange={(e) =>
                                        update({
                                          scorers: spec.scorers.map((x, k) =>
                                            i === k
                                              ? {
                                                  ...x,
                                                  anchors: x.anchors.map(
                                                    (v, l) =>
                                                      j === l
                                                        ? {
                                                            ...v,
                                                            description:
                                                              e.target.value,
                                                          }
                                                        : v,
                                                  ),
                                                }
                                              : x,
                                          ),
                                        })
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                              <button
                                className="studio-text-button"
                                onClick={() =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      j === i
                                        ? {
                                            ...x,
                                            anchors: [
                                              ...x.anchors,
                                              {
                                                score: 1,
                                                description:
                                                  'Describe passing behavior',
                                              },
                                            ],
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              >
                                <Plus size={13} />
                                Add anchor
                              </button>
                            </>
                          ) : (
                            <>
                              <Label
                                title="Output field path"
                                hint="Optional dot path, e.g. queue or invoice.total"
                              />
                              <input
                                className="studio-input"
                                value={s.path}
                                onChange={(e) =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      i === j
                                        ? { ...x, path: e.target.value }
                                        : x,
                                    ),
                                  })
                                }
                              />
                              <Label
                                title="Scorer configuration"
                                hint="JSON schema, regex pattern, numeric tolerance, or contains value."
                              />
                              <JsonField
                                value={s.config}
                                onSave={(config) =>
                                  update({
                                    scorers: spec.scorers.map((x, j) =>
                                      i === j ? { ...x, config } : x,
                                    ),
                                  })
                                }
                              />
                            </>
                          )}
                          <div className="studio-grader-footer">
                            <span>
                              {
                                spec.cases.filter(
                                  (c) =>
                                    c.split === 'calibration' &&
                                    s.id in c.labels,
                                ).length
                              }{' '}
                              human-labeled calibration cases
                            </span>
                            <button
                              className="studio-text-button"
                              onClick={() => setTab('cases')}
                            >
                              Add labels
                              <ArrowRight size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
                {tab === 'review' && (
                  <>
                    <Section
                      eyebrow="05 / EVIDENCE BEFORE CONFIDENCE"
                      title="How strong is your eval?"
                      description="Fix structural gaps, inspect evidence, and calibrate your graders before trusting the results."
                    />
                    <div className="studio-stats">
                      <Stat
                        label="Requirement coverage"
                        value={`${health?.coverage}%`}
                      />
                      <Stat
                        label="Blocking issues"
                        value={
                          health?.diagnostics.filter(
                            (d) => d.severity === 'error',
                          ).length ?? 0
                        }
                      />
                      <Stat
                        label="Needs attention"
                        value={
                          health?.diagnostics.filter(
                            (d) => d.severity === 'warning',
                          ).length ?? 0
                        }
                      />
                    </div>
                    <div className="studio-card">
                      <Label title="Eval diagnostics" />
                      {health?.diagnostics.length ? (
                        health.diagnostics.map((d, i) => (
                          <div
                            className={'studio-diagnostic ' + d.severity}
                            key={i}
                          >
                            <AlertTriangle size={17} />
                            <div>
                              <strong>{d.message}</strong>
                              <p>{d.action}</p>
                            </div>
                            <span>{d.severity}</span>
                          </div>
                        ))
                      ) : (
                        <div className="studio-diagnostic">
                          <CheckCircle2 size={18} />
                          <div>
                            <strong>Structural checks passed</strong>
                            <p>
                              Validate grader agreement and representative
                              coverage before deployment.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="studio-card">
                      <div className="studio-card-top">
                        <Label
                          title="Test against observed outputs"
                          hint="Deterministic preview runs in your browser. Judges and custom code run in your environment."
                        />
                        <button className="studio-btn" onClick={localTest}>
                          <Play size={14} />
                          Run checks
                        </button>
                      </div>
                      <button
                        className="studio-text-button"
                        onClick={() => resultRef.current?.click()}
                      >
                        <Upload size={14} />
                        Import local runner results (.jsonl)
                      </button>
                      <input
                        type="file"
                        accept=".jsonl"
                        ref={resultRef}
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file)
                            void act('Importing results', async () => {
                              const rows = importResults(
                                await file.text(),
                                spec,
                              );
                              setObservations(rows);
                            });
                          e.target.value = '';
                        }}
                      />
                      {observations.map((o) => (
                        <div
                          className="studio-result-row"
                          key={o.caseId + '-' + o.trial}
                        >
                          <strong>{o.caseId}</strong>
                          {o.scores.map((s) => (
                            <span
                              key={s.scorerId}
                              className={
                                'studio-pill ' +
                                (s.status === 'error'
                                  ? 'critical'
                                  : s.passed
                                    ? 'success'
                                    : 'hard')
                              }
                              title={s.reason}
                            >
                              {s.scorerId}:{' '}
                              {s.status === 'scored'
                                ? s.passed
                                  ? 'pass'
                                  : 'fail'
                                : s.status}
                            </span>
                          ))}
                        </div>
                      ))}
                    </div>
                    {observations.length > 0 && (
                      <>
                        <div className="studio-card">
                          <Label
                            title="Requirement outcomes"
                            hint="Independent cases, with all trials required to pass. Errors count as insufficient evidence."
                          />
                          {summarize(spec, observations).requirements.map(
                            (r) => (
                              <div className="studio-result-row" key={r.id}>
                                <strong>{r.id}</strong>
                                <span>
                                  {r.passed}/{r.n} passed
                                </span>
                                <span className="studio-pill neutral">
                                  {r.status}
                                </span>
                              </div>
                            ),
                          )}
                        </div>
                        <div className="studio-card">
                          <Label
                            title="Judge calibration"
                            hint="Compare scored calibration cases to human labels."
                          />
                          {calibrate(spec, observations).map((c) => (
                            <div className="studio-result-row" key={c.scorerId}>
                              <strong>{c.scorerId}</strong>
                              <span>
                                {c.n
                                  ? `${Math.round(c.agreement! * 100)}% agreement · ${c.n} cases`
                                  : 'No scored human labels'}
                              </span>
                              <span>
                                {c.fp} false positives · {c.fn} false negatives
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}
                {tab === 'publish' && (
                  <>
                    <Section
                      eyebrow="06 / YOUR EVAL, YOUR STACK"
                      title="Write once. Take it anywhere."
                      description="Export a runnable package or publish a dataset to your platform. Your eval keeps working without OpenMerit."
                    />
                    <div className="studio-destination-grid">
                      {destinations.map((d) => (
                        <button
                          className={`studio-destination ${destination === d.id ? 'chosen' : ''}`}
                          onClick={() => setDestination(d.id)}
                          key={d.id}
                        >
                          <span className={'studio-platform-logo ' + d.id}>
                            {d.letter}
                          </span>
                          <strong>{d.name}</strong>
                          <small>{d.detail}</small>
                          {destination === d.id && <CheckCircle2 size={16} />}
                        </button>
                      ))}
                    </div>
                    <div className="studio-card">
                      <div className="studio-card-top">
                        <Label
                          title={`${chosen.name} package`}
                          hint="Includes eval.json, .eval.md, dataset, Python runtime, SDK entrypoint, and pinned dependencies."
                        />
                        <span className="studio-pill neutral">
                          PYTHON 3.12+
                        </span>
                      </div>
                      <div className="studio-file-list">
                        {[
                          'eval.json',
                          'eval.eval.md',
                          'cases.jsonl',
                          'openmerit_runtime.py',
                          'run.py',
                          'requirements.txt',
                        ].map((f) => (
                          <div key={f}>
                            <FileText size={15} />
                            <span>{f}</span>
                            <span>
                              {f === 'run.py'
                                ? chosen.name + ' entrypoint'
                                : f === 'openmerit_runtime.py'
                                  ? 'Standalone scorer runtime'
                                  : 'Portable artifact'}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="studio-row">
                        <button
                          className="studio-btn primary"
                          disabled={!!busy}
                          onClick={bundle}
                        >
                          <Download size={15} />
                          Download package
                        </button>
                        <button
                          className="studio-btn"
                          disabled={!!busy}
                          onClick={() =>
                            act('Checking compatibility', async () =>
                              setReport(
                                (
                                  await api<{ report: DiagnosticReport }>(
                                    'eval/compile',
                                    {
                                      spec,
                                      destination,
                                    },
                                  )
                                ).report,
                              ),
                            )
                          }
                        >
                          <ShieldCheck size={15} />
                          Check compatibility
                        </button>
                        <button
                          className="studio-text-button"
                          onClick={() =>
                            download(
                              spec.family + '.eval.md',
                              serialize(spec),
                              'text/markdown',
                            )
                          }
                        >
                          .eval.md only
                        </button>
                      </div>
                      {report && (
                        <div className="studio-export-report">
                          <strong>
                            {report.valid
                              ? 'Compatible SDK bundle'
                              : 'Resolve these compatibility issues'}
                          </strong>
                          {report.diagnostics
                            .filter((d) => d.severity === 'error')
                            .map((d, i) => (
                              <p key={i}>
                                {d.message} — {d.action}
                              </p>
                            ))}
                        </div>
                      )}
                    </div>
                    {destination !== 'local' && (
                      <div className="studio-card">
                        <Label
                          title={`Publish to ${chosen.name}`}
                          hint="Creates a versioned dataset. Run the exported SDK package to execute graders; production rules remain inactive."
                        />
                        <div className="studio-row">
                          <select
                            className="studio-input"
                            aria-label="Destination connection"
                            value={connectionId}
                            onChange={(e) => setConnectionId(e.target.value)}
                          >
                            <option value="">Select a connection</option>
                            {connections
                              .filter((c) => c.destination === destination)
                              .map((c) => (
                                <option value={c.id} key={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                          <button
                            className="studio-btn"
                            onClick={() => setShowConnect(true)}
                          >
                            <Plus size={15} />
                            Connect
                          </button>
                          <button
                            className="studio-btn primary"
                            disabled={!connectionId || !!busy}
                            onClick={() =>
                              act('Planning deployment', async () =>
                                setDeployPlan(
                                  await api<DeploymentPlan>(
                                    'workspace/deploy/plan',
                                    {
                                      connectionId,
                                      spec,
                                    },
                                  ),
                                ),
                              )
                            }
                          >
                            Preview deployment
                            <ArrowRight size={15} />
                          </button>
                        </div>
                        {deployPlan && (
                          <div className="studio-deploy-preview">
                            <h3>Deployment preview</h3>
                            {deployPlan.changes.map((x: string) => (
                              <p key={x}>
                                <Plus size={13} />
                                {x}
                              </p>
                            ))}
                            <button
                              className="studio-btn primary"
                              disabled={!!busy}
                              onClick={() =>
                                act('Publishing dataset', async () => {
                                  const result = await api<Deployment>(
                                    'workspace/deploy',
                                    {
                                      spec,
                                      connectionId,
                                    },
                                  );
                                  setDeployments([
                                    result,
                                    ...deployments.filter(
                                      (d) => d.id !== result.id,
                                    ),
                                  ]);
                                  setDeployPlan(null);
                                  setNotice(
                                    'Dataset published. Download and run the SDK package to execute the eval.',
                                  );
                                })
                              }
                            >
                              Publish dataset
                              <Send size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="studio-card">
                      <Label title="For coding agents & your terminal" />
                      <pre className="studio-code">{`npm run cli -- validate ./task.eval.md\nnpm run cli -- compile ./task.eval.md --target ${destination} --out ./eval-bundle\n${destination !== 'local' ? `npm run cli -- deploy ./task.eval.md --target ${destination} --project PROJECT_ID` : 'python ./eval-bundle/openmerit_runtime.py ./eval-bundle/eval.json --outputs outputs.jsonl'}`}</pre>
                      <p className="studio-caption">
                        CLI credentials stay on your machine. Generated packages
                        have no OpenMerit runtime dependency.
                      </p>
                    </div>
                    {deployments.length > 0 && (
                      <div className="studio-card">
                        <Label title="Deployment history" />
                        {deployments.map((d) => (
                          <div className="studio-result-row" key={d.id}>
                            <strong>{d.resourceName}</strong>
                            <span>{d.status}</span>
                            {d.url && (
                              <a
                                className="studio-text-button"
                                href={d.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open
                                <ExternalLink size={13} />
                              </a>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </main>
              <aside className="studio-inspector">
                <div className="studio-inspector-heading">
                  <span>EVAL AT A GLANCE</span>
                  <Eye size={15} />
                </div>
                <div className="studio-coverage">
                  <div className="studio-coverage-number">
                    {health?.coverage}
                    <span>%</span>
                  </div>
                  <p>requirement coverage</p>
                  <div className="studio-progress">
                    <div style={{ width: `${health?.coverage}%` }} />
                  </div>
                  <small>Criteria linked to both graders and cases.</small>
                </div>
                <div className="studio-inspector-list">
                  <div>
                    <span>Requirements</span>
                    <strong>{spec.requirements.length}</strong>
                  </div>
                  <div>
                    <span>Critical failures</span>
                    <strong>
                      {
                        spec.requirements.filter(
                          (r) => r.severity === 'critical',
                        ).length
                      }
                    </strong>
                  </div>
                  <div>
                    <span>Graders</span>
                    <strong>{spec.scorers.length}</strong>
                  </div>
                  <div>
                    <span>Dataset cases</span>
                    <strong>{spec.cases.length}</strong>
                  </div>
                </div>
                <div className="studio-inspector-target">
                  <span className="studio-section-label">DESTINATION</span>
                  <select
                    value={destination}
                    aria-label="Eval destination"
                    onChange={(e) =>
                      setDestination(e.target.value as Destination)
                    }
                  >
                    {destinations.map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <p>Your definition stays platform-neutral.</p>
                  {readiness && (
                    <div
                      className={`studio-readiness ${readiness.valid ? 'ready' : 'blocked'}`}
                    >
                      <strong>
                        {readiness.valid
                          ? readiness.execution === 'local'
                            ? 'Portable local runtime'
                            : 'Executable SDK package'
                          : `${readiness.blockers.length} compatibility blocker${readiness.blockers.length === 1 ? '' : 's'}`}
                      </strong>
                      <span>
                        {readiness.valid
                          ? 'No authored scorer semantics are dropped.'
                          : readiness.blockers[0]?.message}
                      </span>
                    </div>
                  )}
                </div>
                <div className="studio-inspector-advice">
                  <span className="studio-advice-icon">
                    <BookOpen size={17} />
                  </span>
                  <h4>Test the test.</h4>
                  <p>
                    A grader is a hypothesis about quality. Check it against
                    human judgment before relying on its scores.
                  </p>
                  <button
                    className="studio-text-button"
                    onClick={() => setTab('review')}
                  >
                    Review your eval
                    <ArrowRight size={13} />
                  </button>
                </div>
                <button
                  className="studio-raw-button"
                  onClick={() => {
                    setRawText(JSON.stringify(spec, null, 2));
                    setRawEditor(true);
                  }}
                >
                  <Code2 size={15} />
                  Edit portable definition
                  <ArrowUpRight size={13} />
                </button>
                <button
                  className="studio-raw-button"
                  onClick={() => {
                    setSpec(null);
                    localStorage.removeItem('openmerit:draft');
                  }}
                >
                  <Plus size={15} />
                  Start another eval
                </button>
              </aside>
            </div>
          </>
        )}
        <footer className="studio-footer">
          <span>OpenMerit / Eval Studio</span>
          <span>Creating the test is free. The eval is yours.</span>
          <span>v0.1</span>
        </footer>
      </div>
      {busy && (
        <output className="studio-busy">
          <Loader2 className="spin" size={16} />
          {busy}…
        </output>
      )}
      {showHistory && (
        <Modal title="Saved versions" onClose={() => setShowHistory(false)}>
          {!saved.length ? (
            <p className="studio-caption">
              Save a version to create an immutable snapshot. Draft changes
              autosave separately.
            </p>
          ) : (
            saved.map((s, i) => (
              <button
                key={i}
                className="studio-history-item"
                onClick={() => {
                  setSpec({
                    ...s,
                    version:
                      Math.max(
                        ...saved
                          .filter((x) => x.id === s.id)
                          .map((x) => x.version),
                      ) + 1,
                  });
                  setShowHistory(false);
                }}
              >
                <FileText size={18} />
                <div>
                  <strong>{s.name}</strong>
                  <p>
                    Version {s.version} · {s.cases.length} cases
                  </p>
                </div>
                <ArrowRight size={15} />
              </button>
            ))
          )}
        </Modal>
      )}
      {editingCase && spec && (
        <CaseModal
          item={editingCase}
          spec={spec}
          close={() => setEditingCase(null)}
          save={(c) => {
            update({
              cases: spec.cases.some((x) => x.id === c.id)
                ? spec.cases.map((x) => (x.id === c.id ? c : x))
                : [...spec.cases, c],
            });
            setEditingCase(null);
          }}
        />
      )}
      {rawEditor && (
        <Modal
          title="Portable definition"
          wide
          onClose={() => setRawEditor(false)}
        >
          <p className="studio-caption">
            Canonical JSON is the source of truth. Changes are schema-validated
            before applying.
          </p>
          <textarea
            className="studio-textarea studio-json-editor"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          <button
            className="studio-btn primary"
            onClick={() => {
              try {
                setSpec(parse(rawText));
                setRawEditor(false);
              } catch (e) {
                setNotice(String(e));
              }
            }}
          >
            Validate & apply
            <Check size={15} />
          </button>
        </Modal>
      )}
      {proposal && (
        <Modal
          title="Review AI proposal"
          wide
          onClose={() => setProposal(null)}
        >
          <p className="studio-caption">
            Review the proposed criteria and graders before replacing your
            draft. Your existing cases are preserved.
          </p>
          <div className="studio-two-col">
            <div>
              <Label title="Current criteria" />
              {spec?.requirements.map((r) => (
                <p className="studio-proposal-item" key={r.id}>
                  {r.text}
                </p>
              ))}
            </div>
            <div>
              <Label title="Proposed criteria" />
              {proposal.requirements.map((r) => (
                <p className="studio-proposal-item" key={r.id}>
                  <span className={'studio-pill ' + r.severity}>
                    {r.severity}
                  </span>
                  {r.text}
                </p>
              ))}
            </div>
          </div>
          <details>
            <summary>Inspect complete proposed definition</summary>
            <pre className="studio-code">
              {JSON.stringify(proposal, null, 2)}
            </pre>
          </details>
          <div className="studio-row">
            <button className="studio-btn" onClick={() => setProposal(null)}>
              Keep current draft
            </button>
            <button
              className="studio-btn primary"
              onClick={() => {
                setSpec(proposal);
                setProposal(null);
              }}
            >
              Apply proposal
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
      {importFile && spec && (
        <Modal
          title="Map your dataset"
          wide
          onClose={() => setImportFile(null)}
        >
          <p className="studio-caption">
            {readRows(importFile.text, importFile.format).length} rows found.
            Reference answers and observed outputs are separate fields.
          </p>
          <div className="studio-three-col">
            {(['input', 'expected', 'output'] as const).map((key) => (
              <label className="studio-field" key={key}>
                {key === 'expected'
                  ? 'Reference answer'
                  : key === 'output'
                    ? 'Observed output'
                    : 'Input'}
                <select
                  value={mapping[key]}
                  onChange={(e) =>
                    setMapping({ ...mapping, [key]: e.target.value })
                  }
                >
                  <option value="">None</option>
                  {Object.keys(
                    readRows(importFile.text, importFile.format)[0] ?? {},
                  ).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <pre className="studio-code">
            {JSON.stringify(
              readRows(importFile.text, importFile.format).slice(0, 3),
              null,
              2,
            )}
          </pre>
          <button
            className="studio-btn primary"
            onClick={() => {
              try {
                const cases = mapRows(
                  readRows(importFile.text, importFile.format),
                  mapping,
                  spec.requirements.map((r) => r.id),
                );
                update({ cases: [...spec.cases, ...cases] });
                setImportFile(null);
              } catch (e) {
                setNotice(String(e));
              }
            }}
          >
            Import snapshot
            <ArrowRight size={15} />
          </button>
        </Modal>
      )}
      {showConnect && (
        <ConnectionModal
          close={() => setShowConnect(false)}
          signedIn={signedIn}
          connected={(c) => {
            setConnections([...connections.filter((x) => x.id !== c.id), c]);
            setShowConnect(false);
            setConnectionId(c.id);
            setDestination(c.destination);
          }}
          connections={connections}
          revoked={(id) =>
            setConnections(connections.filter((c) => c.id !== id))
          }
        />
      )}
      {remoteImport && spec && (
        <RemoteImportModal
          connections={connections}
          spec={spec}
          close={() => setRemoteImport(false)}
          imported={(cases) => {
            update({ cases: [...spec.cases, ...cases] });
            setRemoteImport(false);
            setTab('cases');
          }}
        />
      )}
    </div>
  );
}
function Section({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="studio-section-head">
      <div className="studio-eyebrow">{eyebrow}</div>
      <div className="studio-section-title">
        <h2>{title}</h2>
        {action}
      </div>
      <p>{description}</p>
    </div>
  );
}
function Label({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="studio-label">
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="studio-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={'studio-modal ' + (wide ? 'wide' : '')}
      onCancel={onClose}
    >
      <div className="studio-modal-header">
        <h2>{title}</h2>
        <button
          className="studio-icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      <div className="studio-modal-content">{children}</div>
    </dialog>
  );
}
function JsonField({
  value,
  onSave,
}: {
  value: Record<string, unknown>;
  onSave: (value: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)),
    [error, setError] = useState('');
  return (
    <>
      <textarea
        className="studio-textarea mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
              throw Error('Use a JSON object');
            onSave(parsed);
            setError('');
          } catch {
            setError('Invalid JSON object — changes not applied.');
          }
        }}
      />
      {error && (
        <p role="alert" className="studio-error">
          {error}
        </p>
      )}
    </>
  );
}
function CaseModal({
  item,
  spec,
  close,
  save,
}: {
  item: EvalCase;
  spec: EvalSpec;
  close: () => void;
  save: (c: EvalCase) => void;
}) {
  const [c, setC] = useState(item),
    [input, setInput] = useState(pretty(item.input)),
    [expected, setExpected] = useState(pretty(item.expected)),
    [output, setOutput] = useState(pretty(item.output)),
    [error, setError] = useState('');
  return (
    <Modal title="Edit case" wide onClose={close}>
      <div className="studio-two-col">
        <label className="studio-field">
          Case ID
          <input value={c.id} readOnly />
        </label>
        <label className="studio-field">
          Split
          <select
            value={c.split}
            onChange={(e) =>
              setC({ ...c, split: e.target.value as typeof c.split })
            }
          >
            <option>development</option>
            <option>calibration</option>
            <option>holdout</option>
          </select>
        </label>
      </div>
      <Label title="Input" />
      <textarea
        className="studio-textarea"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="studio-two-col">
        <div>
          <Label
            title="Reference answer"
            hint="Reviewed ground truth; optional for reference-free graders."
          />
          <textarea
            className="studio-textarea"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
        </div>
        <div>
          <Label
            title="Observed output"
            hint="What the application actually produced."
          />
          <textarea
            className="studio-textarea"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
          />
        </div>
      </div>
      <Label title="Requirements covered" />
      <div className="studio-checks">
        {spec.requirements.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={c.requirementIds.includes(r.id)}
              onChange={(e) =>
                setC({
                  ...c,
                  requirementIds: e.target.checked
                    ? [...c.requirementIds, r.id]
                    : c.requirementIds.filter((x) => x !== r.id),
                })
              }
            />
            {r.text}
          </label>
        ))}
      </div>
      <Label
        title="Human labels (0–1)"
        hint="Used for calibration when this case belongs to the calibration split."
      />
      <div className="studio-two-col">
        {spec.scorers.map((s) => (
          <label className="studio-field" key={s.id}>
            {s.name}
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={c.labels[s.id] ?? ''}
              placeholder="Unlabeled"
              onChange={(e) => {
                const labels = { ...c.labels };
                if (e.target.value === '') delete labels[s.id];
                else labels[s.id] = Number(e.target.value);
                setC({ ...c, labels });
              }}
            />
          </label>
        ))}
      </div>
      {error && <p className="studio-error">{error}</p>}
      <button
        className="studio-btn primary"
        onClick={() => {
          try {
            save(
              Case.parse({
                ...c,
                input: jsonOrText(input) ?? '',
                expected: jsonOrText(expected),
                output: jsonOrText(output),
              }),
            );
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Save case
        <Check size={15} />
      </button>
    </Modal>
  );
}
function ConnectionModal({
  close,
  signedIn,
  connected,
  connections,
  revoked,
}: {
  close: () => void;
  signedIn: boolean;
  connected: (c: Conn) => void;
  connections: Conn[];
  revoked: (id: string) => void;
}) {
  const [target, setTarget] = useState('langfuse'),
    [name, setName] = useState(''),
    [baseUrl, setBaseUrl] = useState('https://cloud.langfuse.com'),
    [apiKey, setApiKey] = useState(''),
    [publicKey, setPublicKey] = useState(''),
    [projectId, setProjectId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Platform connections" onClose={close}>
      <p className="studio-caption">
        Connect once to import selected examples and publish datasets.
        Credentials are encrypted server-side and can be revoked.
      </p>
      {connections.map((c) => (
        <div className="studio-result-row" key={c.id}>
          <strong>{c.name}</strong>
          <span>{c.destination}</span>
          <button
            className="studio-icon-button"
            aria-label={`Revoke ${c.name}`}
            onClick={async () => {
              try {
                await api<unknown>(
                  'workspace/connections/' + c.id,
                  undefined,
                  'DELETE',
                );
                revoked(c.id);
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {!signedIn ? (
        <Link className="studio-btn primary" href="/api/auth/login">
          Sign in to connect
          <ArrowRight size={15} />
        </Link>
      ) : (
        <>
          <label className="studio-field">
            Platform
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setBaseUrl(
                  e.target.value === 'langfuse'
                    ? 'https://cloud.langfuse.com'
                    : e.target.value === 'braintrust'
                      ? 'https://api.braintrust.dev'
                      : 'https://api.smith.langchain.com',
                );
              }}
            >
              <option value="langfuse">Langfuse</option>
              <option value="braintrust">Braintrust</option>
              <option value="langsmith">LangSmith</option>
            </select>
          </label>
          <label className="studio-field">
            Connection name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My development project"
            />
          </label>
          <label className="studio-field">
            API base URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="studio-field">
            Project ID
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </label>
          {target === 'langfuse' && (
            <label className="studio-field">
              Public key
              <input
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
          <label className="studio-field">
            {target === 'langfuse' ? 'Secret key' : 'API key'}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
          <button
            className="studio-btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const c = await api<Conn>('workspace/connections', {
                  id: crypto.randomUUID(),
                  destination: target,
                  name,
                  baseUrl,
                  apiKey,
                  publicKey,
                  projectId,
                });
                setApiKey('');
                connected(c);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Connection failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Link2 size={15} />
            )}
            Verify & connect
          </button>
        </>
      )}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
function RemoteImportModal({
  connections,
  spec,
  close,
  imported,
}: {
  connections: Conn[];
  spec: EvalSpec;
  close: () => void;
  imported: (cases: EvalCase[]) => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? ''),
    [kind, setKind] = useState('dataset'),
    [id, setId] = useState(''),
    [cases, setCases] = useState<EvalCase[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Import a selected snapshot" wide onClose={close}>
      <p className="studio-caption">
        Only the selected dataset or trace is retrieved. Preview the values
        before adding them to this eval; no continuous synchronization is
        enabled.
      </p>
      <label className="studio-field">
        Connection
        <select
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
        >
          <option value="">Choose a connection</option>
          {connections.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="studio-two-col">
        <label className="studio-field">
          Source
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="dataset">Dataset</option>
            <option value="trace">Trace / observation</option>
          </select>
        </label>
        <label className="studio-field">
          Source ID (Langfuse dataset: name)
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </label>
      </div>
      <button
        className="studio-btn"
        disabled={!connectionId || !id || busy}
        onClick={async () => {
          setBusy(true);
          try {
            setCases(
              await api<EvalCase[]>('workspace/import', {
                connectionId,
                selection: { kind, id },
                requirementIds: spec.requirements.map((r) => r.id),
              }),
            );
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Eye size={15} />
        Fetch preview
      </button>
      {cases && (
        <>
          <p className="studio-caption">
            {cases.length} cases fetched. Raw selected data has been retrieved
            through your OpenMerit connection.
          </p>
          <pre className="studio-code">
            {JSON.stringify(cases.slice(0, 3), null, 2)}
          </pre>
          <button
            className="studio-btn primary"
            onClick={() => imported(cases)}
          >
            Add snapshot to eval
            <Check size={15} />
          </button>
        </>
      )}
      {error && <p className="studio-error">{error}</p>}
    </Modal>
  );
}
