# Pi UX behavioral reference

This document records user-visible behaviors from the earlier OpenMerit implementation. It is not an implementation specification; the current implementation carries forward only the behaviors listed below, rather than its source code, storage schema, or internal contracts.

## Behaviors worth preserving

- A single `/openmerit` command is the primary in-harness entry point.
- Running the command without arguments gives a concise operational summary.
- Long-running work produces short progress notifications instead of appearing silent.
- Users can pause and resume proactive work without uninstalling the extension.
- Users can request work explicitly even when proactive behavior is paused.
- Diagnostics are available from the same command surface.
- Skipped work explains why it was skipped and how the user can proceed.
- Failures are visible, actionable, and do not masquerade as successful evidence.
- The extension behaves sensibly in TUI, RPC, JSON, and print modes; prompts are not attempted when no interactive UI exists.

## Staged behavior

The command shell can carry a proposal through an authorized model change, but only after baseline evidence, budgeted challenger trials, a harness-calculated and OpenMerit-verified frontier, policy approval, and post-swap verification.

## Current direction

The command surface centers on evidence readiness. Its status view should answer:

1. What task profile is active?
2. Which required metrics are observable?
3. Which evaluations exist and have been verified?
4. What intelligent work is Pi currently performing for OpenMerit?
5. What evidence is still missing or insufficient?
6. When is the next assessment due?

The approved command surface is documented in [Pi extension](pi-extension.md).
