# Spam filter · Jev

The [Jev task](https://openmerit.site/demo?task=spam) classifies a community comment as `publish` or `hold` under a narrow promotional-spam policy. Ordinary discussion, criticism, and reports of spam are allowed. Unsolicited promotional solicitations are held. The fixtures contain twelve examples of each class, with six separate verification comments.

## Models and integration

The challenger is [TypeSafe's Jev 1.13](https://openrouter.ai/docs/guides/community/jev), a model that returns typed decisions through OpenRouter's Decisions API. The baseline generates a JSON decision; Jev answers a prepared Choice question. Both receive the same comment and decision criteria, and the application normalizes both results to the same one-field schema. The API adapter is prepared in advance. This demo shows OpenMerit evaluating and switching the application configuration; it does not demonstrate automatically rewriting a chat application to use Jev. Pi's own harness model stays fixed.

## Evaluation and recorded outcome

The prepared policy requires at least 90% exact matches on the 24 fixtures and mean end-to-end latency of at most ten seconds. Among eligible frontier candidates, the demo proposes the lowest observed cost only when it is below the incumbent cost. Six separate inputs verify an approved change. These are point values on a finite synthetic suite, not production success-rate estimates or confidence bounds.

In the recorded run, GPT-4.1 mini matched 22/24 comments and Jev matched 24/24. Measured application cost was approximately $0.074 versus $0.018 per 1,000 comments; mean request latency was 0.78 versus 0.39 seconds. OpenMerit proposed Jev, the operator approved, and Jev passed 6/6 post-swap checks. The sample output highlights one baseline mistake: a comment reporting spam was held by the fixed model and correctly published by Jev. All 24 fixtures remain in the aggregate comparison. These are one run's observations, not promised outcomes or a general moderation benchmark.

See [the demo overview](demo.md) for playback controls, the shared comparison lifecycle, and how to read the measurements.
