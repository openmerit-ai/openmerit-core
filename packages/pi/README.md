# Pi adapter

The first OpenMerit harness adapter, delivered as a Pi extension.

It translates OpenMerit intents into intelligent Pi work and returns structured results with evidence references. Its implementation targets the approved Pi version and follows Pi's extension lifecycle and security rules.

## Initial command surface

- `/openmerit` and `/openmerit status` — show evidence readiness and current activity.
- `/openmerit setup` — explicitly rerun or recover setup; normal interactive setup starts automatically.
- `/openmerit assess` — run an evidence-backed assessment.
- `/openmerit frontier` — request and verify a harness-calculated frontier.
- `/openmerit approve` — authorize the currently proposed supervised swap.
- `/openmerit pause` and `/openmerit resume` — control proactive nudges.
- `/openmerit doctor` — show sanitized adapter diagnostics.

The adapter persists typed intents in Pi's session, supplies them as private extension-authored context, and triggers Pi to perform the work. Pi completes each intent through `openmerit_complete_intent`, returning structured outputs and durable evidence references.

Pi owns the work behind every intent, including use of harness-configured Jev System One access. This adapter deliberately contains no Jev API client and accepts no Jev credential.

The adapter does not select or directly set a model. It issues a bounded mutation intent only after the policy gate authorizes one; Pi performs and proves the change.
