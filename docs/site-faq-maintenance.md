# Website claims maintenance

The homepage (`site/index.html`) has no FAQ block. When a change alters user-visible product behavior, check the homepage and the buyer-question pages (`site/*/index.html`) for claims about that behavior, and correct any that the change makes false in the same pull request. Claims to keep accurate:

- the number of models in the catalogue (`openmerit-core/data/catalogue.json`);
- what OpenMerit does and does not do (it picks models; it does not route live traffic, sell tokens or provide a fallback);
- how to run it: free on your own machine, or hosted at openmerit.ai;
- which coding agents and subscriptions power OpenMerit Harness.

Describe released behavior only. A claim about an unreleased change waits for its release. Earlier per-change review notes are in this file's Git history.
