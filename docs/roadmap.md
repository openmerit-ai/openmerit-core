# Current limitations and roadmap

## Current status

OpenMerit is ready for an initial supervised product trial with Pi. Its protocol, lifecycle, persistence, metric catalogue, frontier verifier, and Pi adapter are implemented and tested. That is not evidence that it optimizes every product; each target workload requires its own profile and representative evaluations.

## Known limitations

- No second harness adapter exists.
- Jev must be configured and invoked by the harness; OpenMerit intentionally provides no client.
- Generic Pi task checkpoints do not replace product telemetry. Setup must create the infrastructure required by the profile.
- Pause state is process-local rather than persisted.
- External evidence authenticity depends on the referenced system.
- Workspace packages are not published to npm.

## Next validation milestones

1. Run setup in one representative product.
2. Verify generated eval and observability artifacts and their side effects.
3. Collect repeated evidence for the confirmed profile.
4. Complete a budgeted A/B/C challenger cycle.
5. Validate the harness-calculated frontier and recommendation.
6. Perform a supervised swap, post-swap verification, and rollback drill.
7. Repeat with a materially different product task before broad readiness claims.

