# Hero resolution correction

The first generated 2 × 2 hero sheet was 2172 × 724 overall, leaving each pose only 1086 × 362. Displaying those cells at up to 1600 CSS pixels made the hero visibly soft. The hero now uses four standalone 2172 × 724 frames and a canvas with the same intrinsic dimensions. This restores four times as many pixels per pose; it does not enlarge the old low-resolution cells.

## Final assets

The table records the original full-resolution opaque frames. As of the 14 October 2026 source update, the homepage uses matching `hero-frame-{0..3}-transparent-v3.webp` cutouts at the same 2172 × 724 resolution. See [the transparency update](site-illustration-transparency.md); it was published on 14 October 2026.

| Pose | Workspace asset | Source |
| --- | --- | --- |
| Rest | `site/assets/motion/hero-frame-0-v2.webp` | Original full-resolution PNG, `exec-c120bc1a-6cea-4824-a27a-81b382be4063.png`. |
| Raise one third | `site/assets/motion/hero-frame-1-v2.webp` | `exec-589f6268-fb65-49db-a701-4b1964405226.png`. |
| Raise two thirds | `site/assets/motion/hero-frame-2-v2.webp` | `exec-647442f6-76f6-408f-9322-01ce14d3b8ba.png`. |
| Inspect | `site/assets/motion/hero-frame-3-v2.webp` | `exec-4906692d-eb37-46a1-9dc0-69545604a8ea.png`. |

The three new poses were generated separately with the built-in image generation tool, using `site/assets/workshop-miniature-diverse.webp` as the reference. New masters are retained under `/Users/lazim/.codex/generated_images/01a0ccec-f664-7e43-bfcf-afbe4fa7f43c/`. The original master is under `/Users/lazim/.codex/generated_images/01a0c9d4-a3f3-7e12-aa03-2b46f42b5e83/`.

Frames 1 and 3 returned at 2171 × 724; one white pixel column was added at the right edge to match the original canvas. No image was resized or upscaled. All four were exported as WebP at quality 94 with smart chroma subsampling. They total 928,000 bytes, including the initial poster.

The original artwork is both the resting animation pose and the static poster. Playback loads the full-size files directly, validates matching dimensions and a minimum width of 2172, then copies each image at its native size. A missing or undersized frame leaves the sharp poster visible. The supporting illustration atlases and all existing timing/controls are unchanged.

## Verification

Chromium and WebKit checked locally and on the deployed site at 1440 CSS pixels with device pixel ratio 2, and at 390 CSS pixels with device pixel ratio 3. Every hero source and the canvas measured 2172 × 724; all four poses rendered distinct pixels. No v1 hero sheet or poster requests occurred. The supporting scenes, pause/resume persistence, reduced motion, failed/undersized-frame fallback, no-JavaScript poster, and page overflow checks passed. Screenshots of resting and raised poses were visually reviewed. The live HTML, player, and all four hero frames match the local files on both domains. Deployment: `10db0b26-2162-4aee-b8dc-6d28bb228d54`. Physical phone hardware was not tested.

## Exact generation prompts

### Frame 1

```text
Use case: precise-object-edit.
Asset type: ONE FULL-RESOLUTION animation frame for a wide website hero.
Input image 1 is the exact edit target, a 2172 x 724 photographic miniature workshop. Preserve its full resolution, crisp faces, fabric threads, tool edges and wood grain.
Return ONE single full-width image at 2172 x 724 pixels (3:1), at least the source resolution. NOT a sprite sheet, NOT a collage, NOT a grid, NOT several panels. The entire output is ONE animation frame. This is a surgical edit of ONLY the seated gray-bearded South Asian craftsman in the ochre vest, third person from left. Preserve all other pixels as closely as possible: exact camera, crop, composition, bench dimensions, all five other makers, clothing, all their hands/tools, scale, notebook, vise, calipers, plant, boxes, sleeping dog, ground shadows and off-white background. No changing lighting, global softness, relighting, new visual style or shifting the scenery. Faces and tools must be as sharply detailed as the original. Do not crop, resize or reinterpret the scene.
The older man's feet, stool, torso and shoulders stay fixed. Only his right forearm, wrist and the tool it holds articulate, with his head following slightly. The right hand is on the LEFT side of his body as seen by the viewer and holds the horizontal metal hand plane. His LEFT hand (viewer right) keeps holding the upright brown-handled tool exactly as in the reference. These must remain TWO SEPARATE solid tools, with natural hands and rigid object shapes. No stretching, warping, melting, crossfades or motion blur.
POSE FOR THIS FRAME:
Raise his RIGHT hand and its horizontal metal plane about one third of the way from the original chest-height position toward his face. The right elbow bends a little; the plane is just below his beard. Keep the left hand and its brown-handled tool stationary. His eyes begin looking at the raised plane.
```

### Frame 2

```text
Use case: precise-object-edit.
Asset type: ONE FULL-RESOLUTION animation frame for a wide website hero.
Input image 1 is the exact edit target, a 2172 x 724 photographic miniature workshop. Preserve its full resolution, crisp faces, fabric threads, tool edges and wood grain.
Return ONE single full-width image at 2172 x 724 pixels (3:1), at least the source resolution. NOT a sprite sheet, NOT a collage, NOT a grid, NOT several panels. The entire output is ONE animation frame. This is a surgical edit of ONLY the seated gray-bearded South Asian craftsman in the ochre vest, third person from left. Preserve all other pixels as closely as possible: exact camera, crop, composition, bench dimensions, all five other makers, clothing, all their hands/tools, scale, notebook, vise, calipers, plant, boxes, sleeping dog, ground shadows and off-white background. No changing lighting, global softness, relighting, new visual style or shifting the scenery. Faces and tools must be as sharply detailed as the original. Do not crop, resize or reinterpret the scene.
The older man's feet, stool, torso and shoulders stay fixed. Only his right forearm, wrist and the tool it holds articulate, with his head following slightly. The right hand is on the LEFT side of his body as seen by the viewer and holds the horizontal metal hand plane. His LEFT hand (viewer right) keeps holding the upright brown-handled tool exactly as in the reference. These must remain TWO SEPARATE solid tools, with natural hands and rigid object shapes. No stretching, warping, melting, crossfades or motion blur.
POSE FOR THIS FRAME:
Raise his RIGHT hand and its horizontal metal plane about two thirds of the way from the original chest-height position toward his eyes. The right elbow bends naturally; the plane is in front of the lower part of his face, wrist tilted very slightly to inspect the edge. Keep the left hand and its brown-handled tool stationary. His eyes look at the raised plane.
```

### Frame 3

```text
Use case: precise-object-edit.
Asset type: ONE FULL-RESOLUTION animation frame for a wide website hero.
Input image 1 is the exact edit target, a 2172 x 724 photographic miniature workshop. Preserve its full resolution, crisp faces, fabric threads, tool edges and wood grain.
Return ONE single full-width image at 2172 x 724 pixels (3:1), at least the source resolution. NOT a sprite sheet, NOT a collage, NOT a grid, NOT several panels. The entire output is ONE animation frame. This is a surgical edit of ONLY the seated gray-bearded South Asian craftsman in the ochre vest, third person from left. Preserve all other pixels as closely as possible: exact camera, crop, composition, bench dimensions, all five other makers, clothing, all their hands/tools, scale, notebook, vise, calipers, plant, boxes, sleeping dog, ground shadows and off-white background. No changing lighting, global softness, relighting, new visual style or shifting the scenery. Faces and tools must be as sharply detailed as the original. Do not crop, resize or reinterpret the scene.
The older man's feet, stool, torso and shoulders stay fixed. Only his right forearm, wrist and the tool it holds articulate, with his head following slightly. The right hand is on the LEFT side of his body as seen by the viewer and holds the horizontal metal hand plane. His LEFT hand (viewer right) keeps holding the upright brown-handled tool exactly as in the reference. These must remain TWO SEPARATE solid tools, with natural hands and rigid object shapes. No stretching, warping, melting, crossfades or motion blur.
POSE FOR THIS FRAME:
Raise his RIGHT hand and its horizontal metal plane to just below eye level so he can inspect its sole. The right elbow bends naturally, and his wrist turns the rigid plane a little toward his gaze. Keep his LEFT hand and its upright brown-handled tool stationary at their original position. His gaze lifts with the plane, shoulders and torso remain planted.
```
