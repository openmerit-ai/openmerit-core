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

const principles = [
  {
    number: "01",
    title: "Resolve by role",
    body: "Ask for the capabilities a role needs. Get back an approved, cacheable inference configuration.",
  },
  {
    number: "02",
    title: "Decide from evidence",
    body: "Use production signals and task-specific scores instead of generic model rankings.",
  },
  {
    number: "03",
    title: "Stay out of the hot path",
    body: "OpenMerit updates desired state. It never proxies a production model request.",
  },
  {
    number: "04",
    title: "Change reversibly",
    body: "Benchmark, canary, promote, hold, or roll back. Every decision stays inspectable.",
  },
];

export default function Home() {
  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="OpenMerit home">
          <Mark />
          <span>OpenMerit</span>
        </a>

        <nav className="nav" aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#principles">Principles</a>
          <a href={blueprintUrl}>Blueprint</a>
        </nav>

        <a className="header-action" href={githubUrl}>
          GitHub <Arrow />
        </a>
      </header>

      <section className="hero shell">
        <div className="hero-kicker"><span /> Open-source infrastructure for agent intelligence</div>
        <h1>
          Keep every agent on the
          <em>right intelligence.</em>
        </h1>
        <p>
          OpenMerit turns production evidence into safe, inspectable inference
          decisions—without sitting in the request path.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href={githubUrl}>
            View on GitHub <Arrow />
          </a>
          <a className="button button-secondary" href="#how">
            How it works <Arrow down />
          </a>
        </div>
      </section>

      <section className="qualities">
        <div className="shell qualities-grid">
          <div><span>01</span><strong>Local first</strong><p>Run the control loop in your environment.</p></div>
          <div><span>02</span><strong>Provider neutral</strong><p>Keep every integration replaceable.</p></div>
          <div><span>03</span><strong>Offline safe</strong><p>Fall back to the last approved decision.</p></div>
        </div>
      </section>

      <section className="how shell" id="how">
        <div className="section-heading">
          <span>How it works</span>
          <h2>One small control loop.</h2>
          <p>OpenMerit connects intent, evidence, and execution. Nothing more.</p>
        </div>

        <div className="flow">
          <article>
            <span className="flow-number">01</span>
            <div className="flow-icon">⌘</div>
            <h3>Harness declares intent</h3>
            <p>Role, workload, and hard requirements.</p>
          </article>
          <span className="flow-arrow" aria-hidden="true">→</span>
          <article className="flow-focus">
            <span className="flow-number">02</span>
            <div className="flow-icon"><Mark /></div>
            <h3>OpenMerit decides</h3>
            <p>Policy and evidence determine desired state.</p>
          </article>
          <span className="flow-arrow" aria-hidden="true">→</span>
          <article>
            <span className="flow-number">03</span>
            <div className="flow-icon">◇</div>
            <h3>Runtime executes</h3>
            <p>The production request remains direct.</p>
          </article>
        </div>
        <p className="flow-note">Conceptual architecture · not a product screenshot</p>
      </section>

      <section className="principles" id="principles">
        <div className="shell">
          <div className="section-heading principles-heading">
            <span>Why OpenMerit</span>
            <h2>Control without complexity.</h2>
          </div>

          <div className="principle-grid">
            {principles.map((principle) => (
              <article key={principle.number}>
                <span>{principle.number}</span>
                <h3>{principle.title}</h3>
                <p>{principle.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="positioning shell">
        <p>Honest by design</p>
        <h2>
          Not “the best model.”
          <span>The best known qualified configuration.</span>
        </h2>
        <div>
          <p>
            Every decision is bound to your current policy, evidence, confidence,
            and workload. No universal score. No hidden vendor incentive.
          </p>
          <a href={blueprintUrl}>Read the product blueprint <Arrow /></a>
        </div>
      </section>

      <section className="cta shell">
        <div>
          <span>Open core · local first</span>
          <h2>Give every role an intelligence contract.</h2>
        </div>
        <div className="cta-actions">
          <a className="button button-light" href={githubUrl}>Explore OpenMerit <Arrow /></a>
          <a className="cta-link" href={blueprintUrl}>Read the blueprint</a>
        </div>
      </section>

      <footer className="site-footer">
        <div className="shell footer-main">
          <div>
            <a className="brand" href="#top"><Mark /><span>OpenMerit</span></a>
            <p>Open-source intelligence control infrastructure for autonomous agents.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href="#how">How it works</a>
            <a href="#principles">Principles</a>
            <a href={blueprintUrl}>Blueprint</a>
            <a href={githubUrl}>GitHub</a>
          </nav>
        </div>
        <div className="shell footer-bottom">
          <span>© 2026 OpenMerit contributors</span>
          <span><i /> Local-first by default</span>
        </div>
      </footer>
    </main>
  );
}
