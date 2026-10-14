# Transparent landing-page illustrations

Published update, 14 October 2026; see the [publication record](site-publication-2026-10-14.md). The homepage's hero, setup toolbox, FAQ makers, and footer dog now use true alpha transparency. The paper panels and multiply/brightness treatments have been removed. The same artwork blends with both device-driven themes and the setup section's tinted surface.

## Assets and provenance

Background removal used the built-in image generation tool, one edit per original frame or atlas, with `transparent_background: true`. The seven edit targets were inspected first. All outputs retained their original 2172 × 724 dimensions and pose sequence. Matching image dimensions did not guarantee matching camera scale: the later hero poses contain scale and position drift. Playback now corrects this as described below. The original opaque assets remain available as references.

All production files live in `site/assets/motion/`. Generated PNG masters are retained under `/Users/lazim/.codex/generated_images/01a139ac-2d03-7392-8dc0-46b579f1b0a2/`.

| Original edit target | Transparent workspace asset | Generated PNG master |
| --- | --- | --- |
| `hero-frame-0-v2.webp` | `hero-frame-0-transparent-v3.webp` | `exec-1b433f01-7b97-4fbd-a783-bc492410a513.png` |
| `hero-frame-1-v2.webp` | `hero-frame-1-transparent-v3.webp` | `exec-37831b7f-2824-4b2b-b596-92776f1a9a2f.png` |
| `hero-frame-2-v2.webp` | `hero-frame-2-transparent-v3.webp` | `exec-ee801aab-4889-4e42-a28c-7cdfe768193b.png` |
| `hero-frame-3-v2.webp` | `hero-frame-3-transparent-v3.webp` | `exec-3e035cd4-1db1-48a1-810c-4b614a1dc2cb.png` |
| `setup-sequence-v1.webp` | `setup-sequence-transparent-v2.webp` | `exec-883bde34-d6b0-493f-948b-6fb1c7a46e1d.png` |
| `questions-sequence-v1.webp` | `questions-sequence-transparent-v2.webp` | `exec-e4f8c1b1-dd3b-4300-bcf2-6ab0ce1a5ca1.png` |
| `rest-sequence-v1.webp` | `rest-sequence-transparent-v2.webp` | `exec-7e61da58-8037-4c73-b093-74baed7c3ab1.png` |

The three supporting posters are `setup-poster-transparent-v2.webp`, `questions-poster-transparent-v2.webp`, and `rest-poster-transparent-v2.webp`. Each is exactly the first 543 × 362 cell of its decoded atlas. The hero poster is its first full-size frame.

Packaging uses `cwebp -q 92 -alpha_q 100 -m 6` without resizing. Supporting posters are extracted from decoded WebP atlases and encoded losslessly, preserving exact displayed first-frame pixels. No alpha edits, warping, generated intermediate poses, or frame registration changes are performed during packaging.

## Playback

The canvas clears before each pose. Once its first complete frame is ready, `.has-motion-frame` makes the poster transparent while retaining its dimensions and accessible image description. This prevents the old pose from showing through transparent regions in subsequent frames.

Pause holds the current pose. Reduced motion restores the static poster and hides the canvas; print does the same. Unloaded or failed animation assets and no-JavaScript visits retain the transparent poster. Timing, lazy loading, offscreen stopping, hidden-tab stopping, and pause preference persistence are unchanged.

### Stable hero stage

The first hero frame supplies the fixed workshop in every pose. Only the seated maker above the bench is replaced, inside the polygon `[[795,235],[1060,235],[1060,435],[1010,463],[825,463],[795,435]]`. The other makers, benches, tools outside this region, plant, stool, legs, and dog remain pixel-identical throughout the loop.

Each moving source pose uses a fixed uniform registration measured against the original stool and bench. The `(scale, x, y)` values are `(1, 0, 0)`, `(1.002, -9, -2)`, `(.956, 43, 46)`, and `(.962, 35, 35)`. These compensate for the generated camera changes; they are not animated zooms, morphs, or interpolation between poses. The clip follows the space above the bench to preserve the stationary tabletop. The calibrated sources must be exactly 2172 × 724; an incompatible source leaves the poster visible.

The three supporting atlases retain whole-cell playback. Their stationary furniture does not show the progressive hero-scale drift; inspection and registration checks found only small existing pose-to-pose texture and placement differences.

## Exact edit prompts

### Hero (same prompt for each of the four original frames)

```text
Use case: background-extraction.
Asset type: production website illustration, original full-width hero animation frame.
Input image 1 is the EDIT TARGET, not a style reference.
Primary request: remove only the solid white/cream paper background, returning the existing artwork on a genuinely transparent alpha background. This is precise background removal, not a new illustration.
Preserve the entire miniature workshop exactly: all six people, faces, poses, clothing, tools, benches, table legs, the small plant and the sleeping dog. Preserve all pixel positions, dimensions, scale, framing, natural colors, lighting, fine texture and focus. Keep this single wide 3:1 canvas at 2172 x 724 pixels, including its original transparent empty margins. Do not rearrange, redraw, crop, enlarge, shrink or change the artwork.
Remove the white background also from every open gap between legs, under tables and around the plant, tools and figures. Preserve white/cream fabric, white hair, dog fur and highlights belonging to real objects as opaque details. Preserve only subtle localized contact shadows as translucent neutral shadows, with no white floor or broad paper patch. Clean antialiased edges with no pale halo, white fringe or checkerboard; it must sit naturally on both warm off-white and charcoal website backgrounds.
Output just the original single complete illustration, unchanged except its background is transparent.
```

### Supporting atlases (common prompt)

```text
Use case: background-extraction.
Asset type: production website animation spritesheet.
Input image 1 is the EDIT TARGET, not a style reference.
Primary request: remove only the solid white/cream background from the existing artwork and output actual transparent alpha.
Keep this entire canvas exactly 2172 x 724 pixels. Preserve the existing FOUR COLUMN by TWO ROW grid of EIGHT distinct poses, with cells of 543 x 362 pixels. Every object in every cell must remain at its original coordinates, scale, framing, orientation and pose. Do not combine cells, crop, scale, rearrange, redraw, add gutters or change anything in the artwork.
Remove all empty white/cream paper around the subjects, including open interior gaps. Preserve light-colored fabric, fur, hair, highlights and other light-colored real subject details as opaque. Keep only subtle localized contact shadows as translucent neutral shadows. No white floor, broad paper patch, pale halo, white fringe, colored edge artifacts, or checkerboard. Clean antialiased edges suitable for both warm off-white and dark charcoal website backgrounds.
```

Each atlas appends its scene-specific constraint:

- **setup:** Preserve the wooden toolbox, contents, brass calipers, folded linen and the exact successive lid-opening angles in all eight cells.
- **questions:** Preserve both makers, their faces, clothing, table, stool, notebook, feet and the exact successive pointing hand poses in all eight cells.
- **rest:** Preserve the spaniel, fur, toolbox, linen and exact successive poses of the dog raising its head in all eight cells.

## Verification

Chromium browser checks passed in both device themes at 1440px and 390px. All four scenes have transparent containers, normal compositing, no image filters, matching intrinsic dimensions, and no horizontal page overflow. Actual timed frame changes were observed for every scene; the underlying poster is hidden during playback. All 28 poses retain substantial transparent regions, and the supporting posters match the decoded first atlas cells pixel for pixel.

The animation regression check now compares rendered RGBA pixels across the complete forward/reverse hero sequence. No pixel changes outside the maker's motion bounds are permitted, and each raised pose must still contain distinct moving pixels. The four corrected poses were also inspected together at their native scale. The previous dimensions-and-motion checks alone were insufficient to catch the camera drift.

Pause and its reload persistence, live theme changes without shifting the artwork, reduced-motion changes, print posters, failed-animation fallback, and no-JavaScript mobile rendering passed. No application runtime errors occurred. Desktop and mobile screenshots were visually reviewed. `npm run check:docs`, JavaScript syntax validation, and `git diff --check` passed. This is browser emulation, not a physical-device test.

## Publication

Integrate these assets, `site/index.html`, `site/styles.css`, and `site/illustrations.js` with the preserved production application described in [the theme notes](site-themes.md). A local preview or successful check does not publish the change. Social sharing artwork is separate from the four on-page illustration scenes and remains unchanged.
