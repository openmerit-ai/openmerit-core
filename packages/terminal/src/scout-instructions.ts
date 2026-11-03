import type { ScoutClient } from './scout-credentials.ts';

export const rule = `# Application model decisions · OpenMerit Scout

Before choosing, recommending, adding, downloading, replacing or configuring
ANY application inference model, load the \`openmerit-scout\` skill and consult
\`scout_models\` on the \`openmerit\` MCP server before committing to a model.
This applies even when the user only asks you to build a feature, never mentions
models or Scout, or names a model themselves (assess it; do not silently replace it).

A pretrained model, local weights, browser inference, an SDK's default model,
embeddings, OCR, speech, image classification, detection and segmentation all
count as model choices, not implementation details. Identify this decision before
writing model-specific code, installing a model package or downloading weights.

Follow the skill's project access policy. If it is missing, ask and save it first.
If Scout is unavailable, fails or has no suitable evidence/candidate, disclose the
gap and pause the model decision; do not fall back to a remembered or SDK-default
model. You may continue work that does not commit to a model.

Do not consult Scout for unrelated edits, normal inference calls using an unchanged
approved model, or this coding agent's own model. Do not reselect approved models
unless the task introduces or changes a model decision.

When the user says "update openmerit", run
\`npx -y openmerit@latest update --scope user\` (use \`--scope project\` if this
rule is in the project's .claude/rules directory). Report the result, including
any conflict or manual-upgrade requirement. Do not delete edited files, bypass
permissions or rerun login automatically. A new session loads updated instructions.
`;

export const skill = `---
name: openmerit-scout
description: Consults OpenMerit Scout before choosing, adding, downloading, replacing or configuring any application inference model, including implicit choices while building features, pretrained browser/local models, SDK defaults, embeddings, OCR, speech, classification, detection, segmentation, LLMs and agents. Not for unrelated edits, ordinary inference calls or this coding agent's own model.
---

# OpenMerit · Scout

Before introducing, recommending, replacing or configuring an application
inference model, call the \`scout_models\` tool on the \`openmerit\` MCP server.
This applies even when the user never mentions models or Scout. Downloading local
weights, using a pretrained browser model or accepting an SDK default is a model
decision: consult Scout before model-specific code, installs or downloads.
Preserve the user's explicit model choice; assess it rather than silently replacing
it. Leave unchanged, approved application selections in place.

## Project policy

Read \`.openmerit/scout.json\` before searching. If it is absent, ask once whether this
project uses **existing-only** (only endpoints it can already reach) or
**existing-first** (prefer them, ask before searching the whole catalogue), and
which public catalogue endpoint IDs it can access. Save the answer:

\`\`\`sh
npx -y openmerit@latest project --policy existing-only --endpoint-id <id> ...
\`\`\`

Never infer access from a model name, SDK or environment-variable name. Never
record credentials, private URLs, prompts or customer data. An empty inventory
is not permission to search all models.

## Searching

Call \`scout_models\` with a non-confidential task description and
\`endpointIds\` set to the saved inventory, including \`[]\` when empty.
Existing-only never broadens. For existing-first, if no existing candidate fits,
explain the gap and ask before a separate search without \`endpointIds\`. Send
only task requirements, never source files, secrets or real customer records.

Compare model AND endpoint, evidence, reference cost/time, unknowns and
warnings. For multiple tasks read \`tasks[].slots[0].recommendations\`; the
top-level list is empty. Prefer the cheapest usable option the quality evidence
supports, without claiming benchmarks prove application accuracy. Use the
returned provider model ID and the project's actual SDK and protocol.

## Boundaries

Ask before adding providers or credentials, spending, deploying or external
writes. Report recommendation, endpoint connectivity and application checks as
separate results, each only after it succeeds. Do not switch this coding agent's
own model.

If Scout fails or has no suitable candidate/evidence for the required deployment,
say so and pause the model decision; do not substitute a remembered recommendation
or SDK default. Continue only model-independent work. Local/browser models are not
exempt when the catalogue lacks coverage. If it reports that the device key is missing,
expired or revoked, run \`npx -y openmerit@latest login\` and then
\`npx -y openmerit@latest install\` again. Never ask the user to paste a key.
`;

export function scoutRule(client: ScoutClient): string {
  if (client === 'claude-code') return rule;
  return rule.replace('load the `openmerit-scout` skill and consult', 'follow the Scout project policy below and consult')
    .replaceAll('`scout_models`', '`mcp__openmerit__scout_models`')
    .replace("Follow the skill's project access policy.", 'Follow the project access policy below.')
    .replace('update --scope user', 'install --client pi --scope user')
    .replace("rule is in the project's .claude/rules directory", "Pi installation is project-scoped");
}

export function scoutSkill(client: ScoutClient): string {
  if (client === 'claude-code') return skill;
  return skill.replaceAll('`scout_models`', '`mcp__openmerit__scout_models`')
    .replace('openmerit@latest login', 'openmerit@latest login --client pi')
    .replace('openmerit@latest install`', 'openmerit@latest install --client pi`')
    .replace('again. Never ask the user to paste a key.', 'again, using `--scope project` on both commands for a project-scoped installation. Never ask the user to paste a key.');
}
