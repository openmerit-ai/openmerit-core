# Focused design and motion review

Reviewed 2026-09-22 using three selected skills from [emilkowalski/skills](https://github.com/emilkowalski/skills), installed with Codex's skill-installer:

- [emil-design-eng](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md): interaction decisions, restraint, and press feedback.
- [review-animations](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/SKILL.md): review of existing motion, including frequency, easing, and rendering cost.
- [mobile-native](https://github.com/emilkowalski/skills/blob/main/skills/mobile-native/SKILL.md): capability-based hover styles and touch feedback.

Installed under `/Users/lazim/.codex/skills/`. The rest of the collection was not needed for this static marketing page. No UI or animation library was added.

## Findings and applied changes

| Before | After | Why |
| --- | --- | --- |
| Link and button hover effects applied on every input type. | All hover effects use `(hover: hover) and (pointer: fine)` in [styles.css](/Users/lazim/Documents/GitHub/openmerit/site/styles.css:97). | Touch should not inherit a persistent hover treatment. |
| No custom press feedback after browser tap highlighting was suppressed. | The primary CTA scales to 0.97 over 160ms and returns over 100ms; other controls use immediate color/opacity feedback. See [styles.css](/Users/lazim/Documents/GitHub/openmerit/site/styles.css:24). | Make pointer-down visible while keeping the page quiet. The curve comes directly from the skill's standards. |
| Opening an FAQ replayed a decorative scene, including when using the keyboard. | FAQ activation only reveals the answer; keyboard activation changes the indicator instantly. Illustration playback is independent of FAQ interaction. See [illustrations.js](/Users/lazim/Documents/GitHub/openmerit/site/illustrations.js) and [styles.css](/Users/lazim/Documents/GitHub/openmerit/site/styles.css:84). | Repeated reading actions do not need a fresh decorative performance. |
| Hover/indicator movement used the generic `ease` curve. | Short 160ms transitions use `cubic-bezier(.23, 1, .32, 1)`. | Responsive, explicit timing for small UI changes. |
| SVG displacement attributes were written on every display frame, including unchanged values. | Writes are limited to about 30 updates/second and unchanged values are skipped in [illustrations.js](/Users/lazim/Documents/GitHub/openmerit/site/illustrations.js:155). | Reduce paint work on high-refresh displays without altering the slow gestures. |

## Verification

- Desktop Chromium at 1440px: CTA press reached scale 0.97 and returned to its initial state; keyboard FAQ activation worked with no indicator transition or illustration replay; no runtime errors.
- Touch emulation at 390px: hover and fine-pointer queries were false; hovering caused no arrow movement; taps opened and closed the menu and FAQ; no horizontal overflow; body copy remained selectable.
- Reduced motion on initial load produced no illustration layers or entrance animation.
- A sampled hero gesture produced 26 attribute updates over one second, versus writing every display frame previously.
- JavaScript syntax and whitespace checks passed.

## Verdict

**Performance:** The photographic illustrations still use painted SVG displacement rather than compositor-only transforms. There is no equivalent transform-only change that preserves local breathing and hand/head movement in the flattened artwork. These effects remain finite, localized, throttled, and disabled offscreen or for reduced motion; this is a deliberate tradeoff, not a claim of GPU-only rendering.

**Accessibility and mobile:** Keyboard behavior, capability queries, and reduced-motion behavior were checked in the browser. Physical-phone touch feel, Safari tap behavior, and performance on older hardware have not been verified.

**Approve the targeted code changes based on the code and browser checks above.** Physical-device validation remains a separate, unverified check.

Published to the existing Cloudflare Worker as version `59b9ebf7-092e-4902-a55f-c7ebb71da8ea`. The updated CSS and illustration script on both public domains match the local files; the production page loads and starts the hero animation without runtime errors.

## Playback follow-up

The user found the motion difficult to see. The initial one-pass behavior also permanently stopped a scene if it left the viewport mid-gesture. Playback now alternates finite gestures with scene-specific rest periods, restarts on re-entry, and has a persistent footer pause control. The hero gestures are slightly stronger. Reduced motion remains respected, and FAQ activation remains independent of the decorative scene.

Actual before/after frame comparisons confirmed visible changes in every scene, rather than checking animated attributes alone. Repeat cycles, interrupted re-entry, pause/resume persistence, reduced motion, and 320px/390px overflow checks passed.

Follow-up deployment: `2ec895d2-f206-4d30-aa63-6a673fd602b8`. The live HTML, CSS, and illustration script on both domains match the local files. A complete play–rest–replay cycle and the footer dog playback were verified on the production page with no runtime errors.
