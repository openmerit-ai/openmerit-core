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

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Check() {
  return <span className="check" aria-hidden="true">✓</span>;
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="OpenMerit home">
          <Mark />
          <span>OpenMerit</span>
        </a>

        <nav className="nav" aria-label="Primary navigation">
          <a href="#why">Why OpenMerit</a>
          <a href="#control-loop">Control loop</a>
          <a href="#protocols">Protocols</a>
          <a href={blueprintUrl}>Blueprint</a>
        </nav>

        <a className="header-action" href={githubUrl}>
          GitHub <Arrow />
        </a>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow-row">
            <span>Open source</span>
            <span>Local first</span>
            <span>Out of the hot path</span>
          </div>

          <h1>
            Keep every agent on the
            <em>right intelligence.</em>
          </h1>
        </div>

        <div className="hero-aside">
          <p>
            OpenMerit is the intelligence control plane between agent harnesses,
            production evidence, and inference infrastructure.
          </p>
          <p className="hero-detail">
            You define what must remain true. The Controller continuously maintains
            the best known qualified inference configuration for every role.
          </p>
          <div className="actions">
            <a className="button button-primary" href={githubUrl}>
              View on GitHub <Arrow />
            </a>
            <a className="button button-secondary" href="#control-loop">
              See the control loop <span aria-hidden="true">↓</span>
            </a>
          </div>
        </div>
      </section>

      <section className="product-stage shell" aria-label="OpenMerit controller preview">
        <div className="stage-glow" />
        <div className="control-panel">
          <div className="panel-topbar">
            <div className="panel-title">
              <Mark />
              <span>Controller</span>
              <span className="status-pill"><i /> running</span>
            </div>
            <div className="panel-context">
              <span>production</span>
              <span>local</span>
            </div>
          </div>

          <div className="panel-body">
            <aside className="roles-pane">
              <div className="pane-label">Intelligence roles</div>
              <div className="role-row active">
                <span className="role-glyph">⌘</span>
                <span>
                  <strong>coding.executor</strong>
                  <small>healthy · high confidence</small>
                </span>
                <span className="live-dot" />
              </div>
              <div className="role-row">
                <span className="role-glyph">◇</span>
                <span>
                  <strong>coding.reviewer</strong>
                  <small>reconsidering</small>
                </span>
                <span className="row-state">02</span>
              </div>
              <div className="role-row">
                <span className="role-glyph">◎</span>
                <span>
                  <strong>support.classifier</strong>
                  <small>canary · 20%</small>
                </span>
                <span className="row-state accent">20</span>
              </div>
              <div className="role-row">
                <span className="role-glyph">∴</span>
                <span>
                  <strong>memory.compactor</strong>
                  <small>current</small>
                </span>
                <span className="row-state">04</span>
              </div>
              <div className="cached-state">
                <span>Fallback</span>
                <strong>Last known good</strong>
                <small>Available offline</small>
              </div>
            </aside>

            <div className="decision-pane">
              <div className="decision-header">
                <div>
                  <span className="pane-label">Desired state</span>
                  <h2>coding.executor</h2>
                </div>
                <span className="decision-id">dec_8291</span>
              </div>

              <div className="profile-switch">
                <div>
                  <span>Current</span>
                  <strong>frontier-large</strong>
                  <small>provider-a · high</small>
                </div>
                <span className="switch-arrow">→</span>
                <div className="recommended">
                  <span>Qualified challenger</span>
                  <strong>code-open-32b</strong>
                  <small>internal-vllm · fp8</small>
                </div>
              </div>

              <div className="metrics-grid">
                <div>
                  <span>Task success</span>
                  <strong>91.8%</strong>
                  <small>within equivalence</small>
                </div>
                <div>
                  <span>Cost / success</span>
                  <strong>$0.38</strong>
                  <small className="positive">−68.6%</small>
                </div>
                <div>
                  <span>p95 duration</span>
                  <strong>7.4m</strong>
                  <small className="positive">−1.5m</small>
                </div>
                <div>
                  <span>Confidence</span>
                  <strong>High</strong>
                  <small>n = 1,204</small>
                </div>
              </div>

              <div className="rollout">
                <div className="rollout-head">
                  <span>Autonomous rollout</span>
                  <strong>Canary verified</strong>
                </div>
                <div className="rollout-track" aria-label="Canary rollout at 20 percent">
                  <span className="complete" />
                  <span className="current" />
                  <span />
                  <span />
                </div>
                <div className="rollout-labels">
                  <span>5%</span>
                  <span>20%</span>
                  <span>50%</span>
                  <span>100%</span>
                </div>
              </div>
            </div>

            <aside className="activity-pane">
              <div className="activity-head">
                <span className="pane-label">Decision record</span>
                <span>live</span>
              </div>
              <ol className="event-list">
                <li className="done">
                  <span className="event-node" />
                  <div>
                    <strong>Signals observed</strong>
                    <small>Quality SLO breach detected</small>
                  </div>
                  <time>09:01</time>
                </li>
                <li className="done">
                  <span className="event-node" />
                  <div>
                    <strong>Challengers benchmarked</strong>
                    <small>3 qualified · 1 dominated</small>
                  </div>
                  <time>09:08</time>
                </li>
                <li className="done">
                  <span className="event-node" />
                  <div>
                    <strong>Policy evaluated</strong>
                    <small>All hard requirements pass</small>
                  </div>
                  <time>09:09</time>
                </li>
                <li className="active-event">
                  <span className="event-node" />
                  <div>
                    <strong>Canary in progress</strong>
                    <small>Observing production evidence</small>
                  </div>
                  <time>now</time>
                </li>
              </ol>
              <div className="policy-chip">
                <span>Policy</span>
                <strong>coding-prod@17</strong>
                <small>Reversible autonomy</small>
              </div>
            </aside>
          </div>
        </div>
      </section>

      <section className="boundary-strip" id="protocols">
        <div className="shell boundary-grid">
          <div className="boundary-intro">
            <span>Three open interfaces</span>
            <strong>One neutral control plane</strong>
          </div>
          <div className="boundary-group">
            <small>Harness</small>
            <span>Pi</span><span>Hermes</span><span>OpenClaw</span>
          </div>
          <div className="boundary-group">
            <small>Signals + scores</small>
            <span>OpenTelemetry</span><span>Langfuse</span><span>Braintrust</span>
          </div>
          <div className="boundary-group">
            <small>Execution</small>
            <span>LiteLLM</span><span>vLLM</span><span>Kubernetes</span>
          </div>
        </div>
      </section>

      <section className="thesis shell" id="why">
        <p className="section-kicker">THE MISSING CONTROL LOOP</p>
        <h2>
          Harnesses declare <mark className="intent">intent<sup>01</sup></mark>.
          Evidence reports <mark className="evidence">reality<sup>02</sup></mark>.
          The Controller maintains <mark className="desired">desired state<sup>03</sup></mark>.
        </h2>
      </section>

      <section className="steps shell" aria-label="How OpenMerit works">
        <article className="step-card">
          <div className="step-visual resolver-visual">
            <div className="request-line">
              <span>role</span>
              <code>coding.executor</code>
            </div>
            <div className="request-line">
              <span>workload</span>
              <code>typescript · tools · 140k</code>
            </div>
            <div className="resolve-result">
              <span>Resolved</span>
              <strong>config_921</strong>
              <small>TTL 24h · fallback cached</small>
            </div>
          </div>
          <span className="step-number">01</span>
          <h3>Resolve by role, not by habit.</h3>
          <p>
            A harness asks for the intelligence a role needs. The Model Resolver
            returns an approved, cacheable inference configuration.
          </p>
        </article>

        <article className="step-card">
          <div className="step-visual evidence-visual">
            <div className="signal-bars" aria-hidden="true">
              <i style={{ height: "36%" }} />
              <i style={{ height: "48%" }} />
              <i style={{ height: "42%" }} />
              <i style={{ height: "62%" }} />
              <i style={{ height: "57%" }} />
              <i style={{ height: "76%" }} />
              <i className="breach" style={{ height: "92%" }} />
              <i style={{ height: "68%" }} />
              <i style={{ height: "59%" }} />
              <i style={{ height: "52%" }} />
              <span className="slo-line">quality floor</span>
            </div>
            <div className="signal-legend">
              <span><i className="legend-dot" /> production evidence</span>
              <strong>SLO breach</strong>
            </div>
          </div>
          <span className="step-number">02</span>
          <h3>Decide from evidence, not leaderboards.</h3>
          <p>
            Production signals and task-specific scores outweigh generic priors.
            Hard requirements remain explicit and inspectable.
          </p>
        </article>

        <article className="step-card">
          <div className="step-visual controller-visual">
            <div className="loop-ring">
              <span className="ring-center">Controller</span>
              <span className="ring-item ring-observe">observe</span>
              <span className="ring-item ring-decide">decide</span>
              <span className="ring-item ring-verify">verify</span>
            </div>
            <div className="controller-note">
              <Check />
              <span><strong>No change</strong><small>stability preferred</small></span>
            </div>
          </div>
          <span className="step-number">03</span>
          <h3>Maintain the best known state.</h3>
          <p>
            The Controller benchmarks, canaries, verifies, promotes, or rolls back.
            No-op is a first-class decision.
          </p>
        </article>
      </section>

      <section className="hot-path-section shell" id="control-loop">
        <div className="hot-path-copy">
          <p className="section-kicker">NON-NEGOTIABLE BOUNDARY</p>
          <h2>
            In the architecture.
            <em>Out of the hot path.</em>
          </h2>
          <p>
            OpenMerit updates desired state. It never carries the production model
            request. If the control plane is unavailable, the agent keeps running on
            its last known good decision.
          </p>
          <ul className="principle-list">
            <li><Check /> No proxy or request router</li>
            <li><Check /> Provider credentials stay local</li>
            <li><Check /> Raw production data can stay local</li>
            <li><Check /> Every autonomous change is reversible</li>
          </ul>
        </div>

        <div className="path-diagram">
          <div className="path-label">Control plane</div>
          <div className="control-path">
            <div><span>Signals + scores</span><small>what happened</small></div>
            <span className="path-arrow">→</span>
            <div className="openmerit-node"><Mark /><span>OpenMerit</span><small>desired state</small></div>
            <span className="path-arrow">→</span>
            <div><span>Configuration</span><small>what should run</small></div>
          </div>
          <div className="path-separator"><span>never in request path</span></div>
          <div className="path-label">Production inference</div>
          <div className="production-path">
            <div><span>Harness</span><small>owns behavior</small></div>
            <span className="path-arrow">→</span>
            <div><span>Inference</span><small>owns execution</small></div>
            <span className="path-arrow">→</span>
            <div><span>Model</span><small>serves request</small></div>
          </div>
          <div className="fallback-stack">
            <span>Fallback order</span>
            <div><b>01</b> fresh approved decision</div>
            <div><b>02</b> cached approved decision</div>
            <div><b>03</b> static project fallback</div>
            <div><b>04</b> harness default</div>
          </div>
        </div>
      </section>

      <section className="decision-section">
        <div className="shell decision-grid">
          <div className="record-card">
            <div className="record-top">
              <span>DECISION RECORD</span>
              <span>HIGH CONFIDENCE</span>
            </div>
            <div className="record-role">
              <span>ROLE</span>
              <strong>coding.executor</strong>
            </div>
            <div className="comparison-table" role="table" aria-label="Decision comparison">
              <div className="table-row table-head" role="row">
                <span role="columnheader">Metric</span>
                <span role="columnheader">Incumbent</span>
                <span role="columnheader">Challenger</span>
              </div>
              <div className="table-row" role="row">
                <span role="cell">Task success</span><span role="cell">91.9%</span><span role="cell">91.8%</span>
              </div>
              <div className="table-row" role="row">
                <span role="cell">Cost / success</span><span role="cell">$1.21</span><span role="cell" className="positive">$0.38</span>
              </div>
              <div className="table-row" role="row">
                <span role="cell">p95 duration</span><span role="cell">8.9m</span><span role="cell" className="positive">7.4m</span>
              </div>
              <div className="table-row" role="row">
                <span role="cell">Hard requirements</span><span role="cell">pass</span><span role="cell" className="positive">pass</span>
              </div>
            </div>
            <div className="record-rationale">
              <span>WHY</span>
              <p>
                Quality is inside the equivalence margin. Every hard requirement
                passes. Cost per successful task falls by 68.6%.
              </p>
            </div>
            <div className="record-footer">
              <span>policy coding-prod@17</span>
              <span>evidence n=9,333</span>
              <span>immutable</span>
            </div>
          </div>

          <div className="decision-copy">
            <p className="section-kicker">HONEST BY DESIGN</p>
            <h2>Not “the best model.” The best known qualified configuration.</h2>
            <p>
              Every decision is bound to current policy, evidence, confidence, and
              workload. No universal score. No opaque recommendation. No vendor
              incentive hidden in the answer.
            </p>
            <a className="text-link" href={blueprintUrl}>
              Read the product blueprint <Arrow />
            </a>
          </div>
        </div>
      </section>

      <section className="open-section shell">
        <div className="open-heading">
          <p className="section-kicker">OPEN CORE, WITHOUT THE CATCH</p>
          <h2>The complete local control loop stays open.</h2>
        </div>
        <div className="open-principles">
          <article>
            <span>01 / LOCAL</span>
            <h3>Run the whole loop in your environment.</h3>
            <p>Resolver, Controller, evals, benchmarks, decisions, canaries, and rollback.</p>
          </article>
          <article>
            <span>02 / NEUTRAL</span>
            <h3>Use any harness, evidence source, or inference stack.</h3>
            <p>Open protocols make each integration replaceable. OpenMerit never resells tokens.</p>
          </article>
          <article>
            <span>03 / AUDITABLE</span>
            <h3>Inspect why intelligence changed.</h3>
            <p>Versioned policies, immutable decision records, and explicit rollout history.</p>
          </article>
        </div>
      </section>

      <section className="final-cta shell">
        <div>
          <p className="section-kicker">BUILD THE CONTROL PLANE WITH US</p>
          <h2>
            Give every role an
            <em>intelligence contract.</em>
          </h2>
        </div>
        <div className="final-actions">
          <a className="button button-primary" href={githubUrl}>
            Explore OpenMerit <Arrow />
          </a>
          <a className="button button-secondary" href={blueprintUrl}>
            Read the blueprint
          </a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-grid">
          <div className="footer-brand">
            <a className="brand" href="#top">
              <Mark />
              <span>OpenMerit</span>
            </a>
            <p>Open-source intelligence control infrastructure for autonomous agents.</p>
          </div>
          <div className="footer-links">
            <div>
              <span>Product</span>
              <a href="#why">Why OpenMerit</a>
              <a href="#control-loop">Control loop</a>
              <a href="#protocols">Protocols</a>
            </div>
            <div>
              <span>Project</span>
              <a href={githubUrl}>GitHub</a>
              <a href={blueprintUrl}>Blueprint</a>
              <a href={`${githubUrl}/issues`}>Issues</a>
            </div>
          </div>
        </div>
        <div className="shell footer-bottom">
          <span>© 2026 OpenMerit contributors</span>
          <span className="footer-status"><i /> local-first by default</span>
        </div>
      </footer>
    </main>
  );
}

