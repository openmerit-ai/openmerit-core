# Current limitations and roadmap

## Current status

OpenMerit is ready for an initial supervised product trial with Pi. Its protocol, lifecycle, persistence, metric catalogue, frontier verifier, and Pi adapter are implemented and tested. That is not evidence that it optimizes every product; each target workload requires its own profile and representative evaluations.

## Known limitations

- No second harness adapter exists.
- Jev must be configured and invoked by the harness; OpenMerit intentionally provides no client.
- Generic Pi task checkpoints do not replace product telemetry. Setup must create the infrastructure required by the profile.
- Published 0.1.5 reports active-session signals and typed metric windows but cannot provision persistent background wakeups. The unreleased source checkout adds an opt-in macOS user LaunchAgent; non-macOS platforms still need an external scheduler.
- The source LaunchAgent now performs a deterministic core baseline check without Pi when evidence is insufficient. This has a local runner test, not a representative product trial. Earlier headless Pi assessment attempts timed out; unattended candidate discovery and model decisions are not yet validated.
- In published 0.1.5, pause does not block automatic dispatch from task, measurement, or session-start signals and resets on process restart. The unreleased source checkout persists pause and gates automatic work; neither version cancels already-active work.
- External evidence authenticity depends on the referenced system.
- The core and protocol workspaces are private; the single `openmerit` npm
  package exposes their public entry points.

## Next validation milestones

1. Run setup in one representative product.
2. Verify generated eval and observability artifacts and their side effects.
3. Collect repeated evidence for the confirmed profile.
4. Complete a budgeted A/B/C challenger cycle.
5. Validate the harness-calculated frontier and recommendation.
6. Perform a supervised swap, post-swap verification, and rollback drill.
7. Repeat with a materially different product task before broad readiness claims.
