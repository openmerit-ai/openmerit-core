const githubUrl = "https://github.com/laz-aslam/openmerit";
const blueprintUrl = `${githubUrl}/blob/main/OpenMerit-v1-product-spec.md`;

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function Arrow({ down = false }: { down?: boolean }) {
  return <span aria-hidden="true">{down ? "↓" : "↗"}</span>;
}

function Check() {
  return <span className="check" aria-hidden="true">✓</span>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="section-label"><span />{children}</p>;
}

export default function Home() {
  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="OpenMerit home">
          <Mark />
          <span>OpenMerit</span>
        </a>

        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#why">Why OpenMerit</a>
          <a href="#controller">Controller</a>
          <a href="#architecture">Architecture</a>
          <a href={blueprintUrl}>Blueprint</a>
        </nav>

        <a className="header-cta" href={githubUrl}>
          View on GitHub <Arrow />
        </a>

        <details className="mobile-nav">
          <summary aria-label="Open navigation"><span /><span /></summary>
          <nav aria-label="Mobile navigation">
            <a href="#why">Why OpenMerit</a>
            <a href="#controller">Controller</a>
            <a href="#architecture">Architecture</a>
            <a href={blueprintUrl}>Blueprint</a>
            <a className="mobile-nav-cta" href={githubUrl}>View on GitHub <Arrow /></a>
          </nav>
        </details>
      </header>

      <section className="hero">
        <div className="hero-orb hero-orb-one" />
        <div className="hero-orb hero-orb-two" />
        <div className="shell hero-grid">
          <div className="hero-copy">
            <span className="hero-pill"><i /> Open source · local first</span>
            <h1>
              The intelligence
              <br />
              control plane for
              <br />
              <em>autonomous agents.</em>
            </h1>
          </div>

          <div className="hero-aside">
            <p className="hero-lead">
              Keep every agent role on the best known qualified inference
              configuration—without putting another proxy in the request path.
            </p>
            <div className="hero-actions">
              <a className="button button-dark" href={githubUrl}>
                Explore OpenMerit <Arrow />
              </a>
              <a className="button button-light" href="#controller">
                See how it works <Arrow down />
              </a>
            </div>
            <div className="hero-notes">
              <span><Check /> Provider-neutral</span>
              <span><Check /> Reversible by design</span>
            </div>
          </div>
        </div>

        <div className="shell product-wrap">
          <div className="product-window" aria-label="OpenMerit controller interface preview">
            <div className="window-bar">
              <div className="window-brand"><Mark /><strong>OpenMerit</strong><span>/ Controller</span></div>
              <div className="window-context"><i /> production <span>⌄</span></div>
            </div>

            <div className="product-layout">
              <aside className="product-sidebar">
                <span className="ui-label">Workspace</span>
                <nav aria-label="Controller preview navigation">
                  <span className="active"><b>⌁</b>Overview</span>
                  <span><b>◇</b>Roles <i>4</i></span>
                  <span><b>⌗</b>Policies</span>
                  <span><b>◉</b>Evidence</span>
                  <span><b>↺</b>Rollouts</span>
                </nav>
                <div className="sidebar-status">
                  <span><i /> System healthy</span>
                  <small>Last sync 12s ago</small>
                </div>
              </aside>

              <div className="product-main">
                <div className="product-heading">
                  <div>
                    <span className="ui-label">Intelligence role</span>
                    <h2>coding.executor</h2>
                  </div>
                  <span className="confidence"><i /> High confidence</span>
                </div>

                <div className="model-change">
                  <div>
                    <span>Current</span>
                    <strong>frontier-large</strong>
                    <small>provider-a · high</small>
                  </div>
                  <span className="change-arrow">→</span>
                  <div className="recommended-model">
                    <span>Qualified challenger</span>
                    <strong>code-open-32b</strong>
                    <small>internal-vllm · fp8</small>
                  </div>
                </div>

                <div className="metric-row">
                  <div><span>Task success</span><strong>91.8%</strong><small>equivalent</small></div>
                  <div><span>Cost / success</span><strong>$0.38</strong><small className="good">↓ 68.6%</small></div>
                  <div><span>p95 duration</span><strong>7.4m</strong><small className="good">↓ 1.5m</small></div>
                  <div><span>Evidence</span><strong>1,204</strong><small>qualified runs</small></div>
                </div>

                <div className="rollout-card">
                  <div className="rollout-title">
                    <div><span>Autonomous rollout</span><strong>Canary verified</strong></div>
                    <span>20%</span>
                  </div>
                  <div className="progress"><i /><i className="current" /><i /><i /></div>
                  <div className="progress-labels"><span>5%</span><span>20%</span><span>50%</span><span>100%</span></div>
                </div>
              </div>

              <aside className="activity-panel">
                <div className="activity-title"><span className="ui-label">Decision record</span><b><i /> Live</b></div>
                <ol>
                  <li className="done"><i /><div><strong>Signals observed</strong><small>Quality SLO breach detected</small></div><time>09:01</time></li>
                  <li className="done"><i /><div><strong>Challengers tested</strong><small>3 qualified · 1 dominated</small></div><time>09:08</time></li>
                  <li className="done"><i /><div><strong>Policy evaluated</strong><small>All hard requirements pass</small></div><time>09:09</time></li>
                  <li className="live"><i /><div><strong>Canary running</strong><small>Observing production evidence</small></div><time>now</time></li>
                </ol>
                <div className="policy-card"><span>Active policy</span><strong>coding-prod@17</strong><small>Reversible autonomy</small></div>
              </aside>
            </div>
          </div>
          <p className="product-caption"><span>01</span> One control surface for every agent, model, and environment.</p>
        </div>
      </section>

      <section className="integration-strip" aria-label="Open interfaces">
        <div className="shell integration-grid">
          <p>Works with the stack you already run.</p>
          <div><span>Harnesses</span><strong>Pi</strong><strong>Hermes</strong><strong>OpenClaw</strong></div>
          <div><span>Evidence</span><strong>OpenTelemetry</strong><strong>Langfuse</strong><strong>Braintrust</strong></div>
          <div><span>Execution</span><strong>LiteLLM</strong><strong>vLLM</strong><strong>Kubernetes</strong></div>
        </div>
      </section>

      <section className="shell thesis" id="why">
        <SectionLabel>The missing control loop</SectionLabel>
        <h2>
          Your harness knows what it needs.
          <span>Your telemetry knows what happened.</span>
          <em>OpenMerit keeps the two in sync.</em>
        </h2>
        <p>
          Models, providers, runtimes, and prices keep moving. OpenMerit turns
          production evidence into safe, inspectable changes to desired state.
        </p>
      </section>

      <section className="shell value-grid">
        <article className="value-card value-blue">
          <span className="value-number">01</span>
          <div className="resolver-mini">
            <span>role</span><code>coding.executor</code>
            <span>workload</span><code>typescript · tools · 140k</code>
            <div><small>Resolved configuration</small><strong>config_921</strong><i>approved</i></div>
          </div>
          <h3>Resolve by role.<br />Not by habit.</h3>
          <p>Harnesses ask for capabilities. The resolver returns an approved, cacheable configuration.</p>
        </article>

        <article className="value-card value-coral">
          <span className="value-number">02</span>
          <div className="evidence-mini">
            <div className="bars" aria-hidden="true">
              <i /><i /><i /><i /><i /><i className="breach" /><i /><i />
              <span>quality floor</span>
            </div>
            <div><span><i /> production evidence</span><strong>SLO breach</strong></div>
          </div>
          <h3>Decide from evidence.<br />Not leaderboards.</h3>
          <p>Task-specific signals and hard requirements outweigh generic model priors.</p>
        </article>

        <article className="value-card value-mint">
          <span className="value-number">03</span>
          <div className="loop-mini">
            <span className="loop-center">Controller</span>
            <span className="loop-item observe">observe</span>
            <span className="loop-item decide">decide</span>
            <span className="loop-item verify">verify</span>
          </div>
          <h3>Change carefully.<br />Or do nothing.</h3>
          <p>Benchmark, canary, verify, promote, or roll back. No-op is always a valid decision.</p>
        </article>
      </section>

      <section className="feature-section" id="controller">
        <div className="shell feature-row">
          <div className="feature-copy">
            <SectionLabel>Role-based resolution</SectionLabel>
            <h2>Give every role an <em>intelligence contract.</em></h2>
            <p>
              Stop wiring model names into agent code. Define quality floors,
              latency ceilings, tool requirements, and cost constraints once.
            </p>
            <ul>
              <li><Check /> Stable role-based API</li>
              <li><Check /> Cacheable, offline-safe decisions</li>
              <li><Check /> Explicit fallback order</li>
            </ul>
          </div>

          <div className="feature-visual resolver-board">
            <div className="board-top"><span>RESOLVE REQUEST</span><span>req_8f21</span></div>
            <div className="code-lines">
              <span><b>role</b><code>&quot;coding.executor&quot;</code></span>
              <span><b>context</b><code>&#123; language: &quot;typescript&quot; &#125;</code></span>
              <span><b>requirements</b><code>[&quot;tools&quot;, &quot;vision&quot;]</code></span>
            </div>
            <div className="resolve-arrow">↓</div>
            <div className="resolved-card">
              <div><span>Approved configuration</span><i>fresh · ttl 24h</i></div>
              <h3>code-open-32b</h3>
              <p>internal-vllm <span>·</span> fp8 <span>·</span> tools-v4</p>
              <div className="config-tags"><span>quality ≥ 0.91</span><span>p95 ≤ 8m</span><span>$ ≤ 0.50</span></div>
            </div>
          </div>
        </div>

        <div className="shell feature-row feature-row-reverse">
          <div className="feature-copy">
            <SectionLabel>Continuous control</SectionLabel>
            <h2>A controller that knows when <em>not to change.</em></h2>
            <p>
              OpenMerit watches production evidence, qualifies challengers, and
              only changes desired state when the evidence clears your policy.
            </p>
            <a className="text-link" href={blueprintUrl}>Read the control-loop blueprint <Arrow /></a>
          </div>

          <div className="feature-visual timeline-board">
            <div className="board-top"><span>CONTROLLER ACTIVITY</span><span><i /> observing</span></div>
            <div className="timeline-chart">
              <div className="chart-labels"><span>0.94</span><span>0.92</span><span>0.90</span></div>
              <div className="chart-area">
                <span className="threshold">quality floor</span>
                <svg viewBox="0 0 600 170" role="img" aria-label="Quality evidence over time">
                  <defs>
                    <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#596fff" stopOpacity=".24" />
                      <stop offset="100%" stopColor="#596fff" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path className="chart-fill" d="M0 96 C60 82 96 74 140 88 S225 126 270 103 S352 50 400 62 S475 82 520 54 S570 44 600 30 V170 H0 Z" />
                  <path className="chart-line" d="M0 96 C60 82 96 74 140 88 S225 126 270 103 S352 50 400 62 S475 82 520 54 S570 44 600 30" />
                </svg>
                <span className="chart-event event-one"><i />challenger qualified</span>
                <span className="chart-event event-two"><i />canary promoted</span>
              </div>
            </div>
            <div className="timeline-footer"><span>7d evidence window</span><strong>1,204 qualified runs</strong></div>
          </div>
        </div>
      </section>

      <section className="architecture-section" id="architecture">
        <div className="architecture-orb" />
        <div className="shell architecture-grid">
          <div className="architecture-copy">
            <SectionLabel>Non-negotiable boundary</SectionLabel>
            <h2>In the architecture.<br /><em>Out of the hot path.</em></h2>
            <p>
              OpenMerit updates desired state. It never carries your production
              model request. If the controller disappears, your agents keep running.
            </p>
            <div className="architecture-points">
              <span><Check /><b>No proxy</b><small>Zero request-path dependency</small></span>
              <span><Check /><b>Local credentials</b><small>Provider keys stay yours</small></span>
              <span><Check /><b>Safe failure</b><small>Last known good is cached</small></span>
            </div>
          </div>

          <div className="architecture-map">
            <span className="map-label">Control plane</span>
            <div className="map-row control-row">
              <div><span>Signals + scores</span><small>what happened</small></div>
              <b>→</b>
              <div className="map-openmerit"><Mark /><span>OpenMerit</span><small>desired state</small></div>
              <b>→</b>
              <div><span>Configuration</span><small>what should run</small></div>
            </div>
            <div className="map-boundary"><span>never in request path</span></div>
            <span className="map-label">Production inference</span>
            <div className="map-row production-row">
              <div><span>Agent harness</span><small>owns behavior</small></div>
              <b>→</b>
              <div><span>Inference runtime</span><small>owns execution</small></div>
              <b>→</b>
              <div><span>Model</span><small>serves request</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="shell principles-section">
        <div className="principles-heading">
          <SectionLabel>Open core, without the catch</SectionLabel>
          <h2>The complete local control loop stays open.</h2>
        </div>
        <div className="principle-cards">
          <article><span>01</span><h3>Run it locally.</h3><p>Resolver, controller, evals, decisions, canaries, and rollback in your environment.</p></article>
          <article><span>02</span><h3>Connect anything.</h3><p>Open interfaces keep every harness, evidence source, and inference stack replaceable.</p></article>
          <article><span>03</span><h3>Inspect every change.</h3><p>Versioned policies and immutable records explain why intelligence changed.</p></article>
        </div>
      </section>

      <section className="shell final-cta">
        <div className="cta-orb cta-orb-one" />
        <div className="cta-orb cta-orb-two" />
        <div>
          <SectionLabel>Build the control plane with us</SectionLabel>
          <h2>Keep every agent on the <em>right intelligence.</em></h2>
        </div>
        <div className="final-actions">
          <a className="button button-dark" href={githubUrl}>Explore OpenMerit <Arrow /></a>
          <a className="button button-light" href={blueprintUrl}>Read the blueprint</a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-main">
          <div className="footer-brand">
            <a className="brand" href="#top"><Mark /><span>OpenMerit</span></a>
            <p>Open-source intelligence control infrastructure for autonomous agents.</p>
          </div>
          <div className="footer-links">
            <div><span>Product</span><a href="#why">Why OpenMerit</a><a href="#controller">Controller</a><a href="#architecture">Architecture</a></div>
            <div><span>Project</span><a href={githubUrl}>GitHub</a><a href={blueprintUrl}>Blueprint</a><a href={`${githubUrl}/issues`}>Issues</a></div>
          </div>
        </div>
        <div className="shell footer-bottom">
          <span>© 2026 OpenMerit contributors</span>
          <span className="footer-status"><i /> Local-first by default</span>
        </div>
      </footer>
    </main>
  );
}
