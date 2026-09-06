const githubUrl = "https://github.com/laz-aslam/openmerit";
const blueprintUrl = `${githubUrl}/blob/main/OpenMerit-v1-product-spec.md`;

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
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

function WaveLines({ compact = false }: { compact?: boolean }) {
  const paths = [
    "M-60 248 C130 112 250 386 470 210 S790 16 1110 166",
    "M-60 264 C125 128 260 400 478 226 S798 32 1110 182",
    "M-60 280 C120 144 270 414 486 242 S806 48 1110 198",
    "M-60 296 C115 160 280 428 494 258 S814 64 1110 214",
    "M-60 312 C110 176 290 442 502 274 S822 80 1110 230",
    "M-60 328 C105 192 300 456 510 290 S830 96 1110 246",
    "M-60 344 C100 208 310 470 518 306 S838 112 1110 262",
    "M-60 360 C95 224 320 484 526 322 S846 128 1110 278",
    "M-60 376 C90 240 330 498 534 338 S854 144 1110 294",
    "M-60 392 C85 256 340 512 542 354 S862 160 1110 310",
  ];

  return (
    <svg
      className={compact ? "wave-lines wave-lines-compact" : "wave-lines"}
      viewBox="0 0 1050 520"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={compact ? "wave-compact" : "wave-main"} x1="0" x2="1">
          <stop offset="0%" stopColor="#89ddff" />
          <stop offset="47%" stopColor="#5b70ff" />
          <stop offset="100%" stopColor="#73e5c6" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${compact ? "wave-compact" : "wave-main"})`}>
        {paths.map((path, index) => (
          <path key={path} d={path} style={{ animationDelay: `${index * -0.23}s` }} />
        ))}
      </g>
    </svg>
  );
}

const capabilities = [
  {
    eyebrow: "Model Resolver",
    title: "Resolve by role, not provider.",
    body: "Harnesses ask for capabilities. OpenMerit returns an approved, cacheable inference configuration.",
    visual: "resolver",
  },
  {
    eyebrow: "Production evidence",
    title: "Use the signal that matters.",
    body: "Task-specific scores and production outcomes outweigh generic benchmarks and vendor claims.",
    visual: "evidence",
  },
  {
    eyebrow: "Policy controller",
    title: "Change only when qualified.",
    body: "Benchmark, canary, verify, promote—or hold. No-op is always a first-class decision.",
    visual: "controller",
  },
  {
    eyebrow: "Local operation",
    title: "Keep running when control is offline.",
    body: "The last approved decision stays cached. Your production inference path remains independent.",
    visual: "fallback",
  },
];

export default function Home() {
  return (
    <main id="top">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#top" aria-label="OpenMerit home">
            <Mark />
            <span>OpenMerit</span>
          </a>

          <nav className="desktop-nav" aria-label="Primary navigation">
            <a href="#platform">Platform <span>⌄</span></a>
            <a href="#principles">Principles</a>
            <a href="#architecture">Architecture</a>
            <a href={blueprintUrl}>Blueprint</a>
          </nav>

          <div className="header-actions">
            <a className="header-link" href={githubUrl}>GitHub</a>
            <a className="header-button" href={blueprintUrl}>Read the blueprint</a>
          </div>

          <details className="mobile-nav">
            <summary aria-label="Open navigation"><span /><span /></summary>
            <nav>
              <a href="#platform">Platform</a>
              <a href="#principles">Principles</a>
              <a href="#architecture">Architecture</a>
              <a href={blueprintUrl}>Blueprint</a>
              <a className="mobile-nav-button" href={githubUrl}>View on GitHub <Arrow /></a>
            </nav>
          </details>
        </div>
      </header>

      <section className="hero">
        <WaveLines />
        <div className="hero-fade" />
        <div className="shell hero-grid">
          <div className="hero-copy">
            <a className="announcement" href={blueprintUrl}>
              <span>Open source</span>
              The v1 blueprint is public
              <b>›</b>
            </a>
            <h1>The intelligence control plane agents build on.</h1>
            <p>
              Keep every role on the best known qualified inference configuration—
              without putting another proxy in the request path.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href={githubUrl}>View on GitHub <Arrow /></a>
              <a className="button button-secondary" href="#platform">Explore the platform <Arrow down /></a>
            </div>
          </div>

          <div className="hero-visual" aria-label="Conceptual OpenMerit architecture">
            <div className="visual-label">Conceptual architecture</div>
            <div className="architecture-canvas">
              <div className="canvas-title">
                <Mark />
                <strong>OpenMerit</strong>
                <span>control loop</span>
              </div>
              <div className="canvas-flow">
                <div>
                  <span className="node-icon">⌘</span>
                  <small>Intent</small>
                  <strong>Agent harness</strong>
                  <p>role + constraints</p>
                </div>
                <i>→</i>
                <div className="active-node">
                  <span className="node-icon"><Mark /></span>
                  <small>Decision</small>
                  <strong>OpenMerit</strong>
                  <p>qualified state</p>
                </div>
                <i>→</i>
                <div>
                  <span className="node-icon">◇</span>
                  <small>Execution</small>
                  <strong>Inference</strong>
                  <p>direct request</p>
                </div>
              </div>
              <div className="canvas-boundary">
                <span><i /> Evidence returns asynchronously</span>
                <strong>Never in the hot path</strong>
              </div>
            </div>
            <p>System boundaries shown for explanation—not a product screenshot.</p>
          </div>
        </div>
      </section>

      <section className="boundary-band">
        <div className="shell boundary-grid">
          <div>
            <span>01</span>
            <strong>Harness intent</strong>
            <p>What the role needs</p>
          </div>
          <div>
            <span>02</span>
            <strong>Production evidence</strong>
            <p>What actually happened</p>
          </div>
          <div>
            <span>03</span>
            <strong>Desired state</strong>
            <p>What should run next</p>
          </div>
          <div>
            <span>04</span>
            <strong>Direct execution</strong>
            <p>No OpenMerit request hop</p>
          </div>
        </div>
      </section>

      <section className="platform shell" id="platform">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Platform</span>
            <h2>One control plane for every agent role.</h2>
            <p>Intelligence that keeps moving as models, workloads, and evidence change.</p>
          </div>
          <a className="button button-dark" href={blueprintUrl}>See how it works <Arrow /></a>
        </div>

        <div className="capability-grid">
          {capabilities.map((capability) => (
            <article className={`capability-card capability-${capability.visual}`} key={capability.title}>
              <div className="capability-visual" aria-hidden="true">
                {capability.visual === "resolver" && (
                  <div className="resolver-graphic">
                    <span><i /> role.coding</span>
                    <b>→</b>
                    <span className="resolved"><Mark /> approved config</span>
                  </div>
                )}
                {capability.visual === "evidence" && (
                  <div className="evidence-graphic">
                    <span /><span /><span /><span /><span /><span />
                    <i>policy floor</i>
                  </div>
                )}
                {capability.visual === "controller" && (
                  <div className="loop-graphic">
                    <span className="loop-center"><Mark /></span>
                    <span className="loop-observe">observe</span>
                    <span className="loop-decide">decide</span>
                    <span className="loop-verify">verify</span>
                  </div>
                )}
                {capability.visual === "fallback" && (
                  <div className="fallback-graphic">
                    <span><b>01</b> fresh decision</span>
                    <span><b>02</b> cached decision</span>
                    <span><b>03</b> project fallback</span>
                  </div>
                )}
              </div>
              <div className="capability-copy">
                <span>{capability.eyebrow}</span>
                <h3>{capability.title}</h3>
                <p>{capability.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="ticker" aria-label="OpenMerit control loop">
        <div>
          <span>Resolve by role</span><i />
          <span>Observe evidence</span><i />
          <span>Evaluate policy</span><i />
          <span>Canary safely</span><i />
          <span>Publish desired state</span><i />
          <span>Prefer stability</span>
        </div>
      </section>

      <section className="principles shell" id="principles">
        <div className="section-heading principles-heading">
          <div>
            <span className="section-kicker">Built on clear boundaries</span>
            <h2>Autonomy without surrendering control.</h2>
          </div>
        </div>

        <div className="principle-cards">
          <article className="principle-card principle-dark">
            <div className="principle-mark">01</div>
            <div className="principle-copy">
              <span>Out of the hot path</span>
              <h3>Your agents do not depend on OpenMerit to answer a request.</h3>
              <p>
                The controller updates desired state. Harnesses call inference
                directly and keep running on the last known good decision.
              </p>
            </div>
            <div className="path-illustration" aria-hidden="true">
              <div><span>Harness</span><i>→</i><span>Runtime</span><i>→</i><span>Model</span></div>
              <p>Production request</p>
            </div>
          </article>

          <article className="principle-card principle-blue">
            <WaveLines compact />
            <div className="principle-mark">02</div>
            <div className="principle-copy">
              <span>Honest by design</span>
              <h3>Every autonomous change comes with a reason and a way back.</h3>
              <p>
                Policy, evidence, confidence, outcome, and rollback remain explicit
                in every decision record.
              </p>
            </div>
            <div className="record-illustration" aria-hidden="true">
              <span><i /> Policy</span>
              <span><i /> Evidence</span>
              <span><i /> Confidence</span>
              <span><i /> Outcome</span>
            </div>
          </article>
        </div>
      </section>

      <section className="positioning" id="architecture">
        <div className="shell positioning-grid">
          <div>
            <span className="section-kicker">The difference</span>
            <h2>Not “the best model.”</h2>
          </div>
          <div>
            <h3>The best known qualified configuration.</h3>
            <p>
              Every answer is specific to your role, workload, policy, and current
              evidence. No universal leaderboard. No opaque recommendation. No
              hidden incentive to sell you tokens.
            </p>
            <a href={blueprintUrl}>Read the product blueprint <Arrow /></a>
          </div>
        </div>
      </section>

      <section className="open-source shell">
        <div className="open-source-heading">
          <span className="section-kicker">Open core, without the catch</span>
          <h2>The complete local control loop stays open.</h2>
        </div>
        <div className="open-source-grid">
          <article><span>01</span><h3>Run it locally</h3><p>Resolver, policies, evidence, decisions, canaries, and rollback in your environment.</p></article>
          <article><span>02</span><h3>Connect anything</h3><p>Open interfaces keep every harness, evidence source, and inference stack replaceable.</p></article>
          <article><span>03</span><h3>Inspect every change</h3><p>Versioned policy and immutable records explain why desired state moved.</p></article>
        </div>
      </section>

      <section className="closing-cta">
        <WaveLines compact />
        <div className="shell closing-inner">
          <h2>Give every role an intelligence contract.</h2>
          <div>
            <a className="button button-ghost" href={blueprintUrl}>Read the blueprint</a>
            <a className="button button-primary" href={githubUrl}>View on GitHub <Arrow /></a>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-grid">
          <div className="footer-brand">
            <a className="brand" href="#top"><Mark /><span>OpenMerit</span></a>
            <p>Open-source intelligence control infrastructure for autonomous agents.</p>
          </div>
          <div>
            <span>Explore</span>
            <a href="#platform">Platform</a>
            <a href="#principles">Principles</a>
            <a href="#architecture">Architecture</a>
          </div>
          <div>
            <span>Project</span>
            <a href={githubUrl}>GitHub</a>
            <a href={blueprintUrl}>Blueprint</a>
            <a href={`${githubUrl}/issues`}>Issues</a>
          </div>
          <div>
            <span>Source</span>
            <a href={`${githubUrl}#readme`}>README</a>
            <a href={`${githubUrl}/commits/main`}>Changelog</a>
            <a href={`${githubUrl}/blob/main/LICENSE`}>License</a>
          </div>
        </div>
        <div className="shell footer-bottom">
          <span>© 2026 OpenMerit contributors</span>
          <span><i /> Local-first by default</span>
        </div>
      </footer>
    </main>
  );
}
