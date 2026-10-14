# Illustrated frame sequences

Generated with the built-in image generation tool on 2026-09-23. These replace the SVG displacement animation. Each atlas contains distinct poses. Supporting scenes copy whole cells to a canvas; the current hero source keeps a fixed stage and registers only the moving maker above the bench. There are no mesh deformations, optical-flow frames, morphs, or crossfades.

## Assets and playback

Published update, 14 October 2026: the active homepage assets now use transparent backgrounds. The four hero files are `hero-frame-{0..3}-transparent-v3.webp`; the supporting atlases and posters are `{setup,questions,rest}-sequence-transparent-v2.webp` and `{setup,questions,rest}-poster-transparent-v2.webp`. Their dimensions, poses, frame order, and timing remain unchanged. The hero renderer corrects camera drift in the generated sources by retaining the first-frame workshop and registering only the moving maker. See [transparent asset provenance, packaging, and playback](site-illustration-transparency.md). The table and generation notes below document the original opaque versions retained as references; their byte totals do not describe the transparent exports.

| Scene | Atlas | Grid | Frame size | Action |
| --- | --- | --- | --- | --- |
| Hero | `site/assets/motion/hero-frame-{0..3}-v2.webp` | Four individual images | 2172 × 724 | Seated maker raises and examines a hand plane. |
| Setup | `site/assets/motion/setup-sequence-v1.webp` | 4 × 2 | 543 × 362 | Toolbox lid rotates toward closed and opens again. |
| Questions | `site/assets/motion/questions-sequence-v1.webp` | 4 × 2 | 543 × 362 | The makers move their hands across the notebook. |
| Footer | `site/assets/motion/rest-sequence-v1.webp` | 4 × 2 | 543 × 362 | The dog opens its eyes and lifts its head. |

Matching `*-poster-v1.webp` images use the first cell for the supporting scenes. The hero uses its full-size `hero-frame-0-v2.webp` as its poster. They remain available without JavaScript, under reduced motion, or when animation assets fail to load. The original illustrations remain in `site/assets/` as references.

Frames are played in order, then in reverse through the intermediate poses. Atlas cells are read left-to-right, top-to-bottom. Scene-specific holds at the endpoints produce deliberate stop-motion timing. Pausing freezes the current pose; reduced motion shows the poster. Timers stop offscreen and while the document is hidden. Animation assets load only when motion is allowed and the illustration is visible. The four full-size hero frames total approximately 906 KiB, including its poster; the three supporting atlases total approximately 486 KiB.

## Packaging

The hero's original grid reduced every pose to 1086 × 362 and was visibly soft at the website's display size. It has been replaced with four standalone 2172 × 724 images. The first is the original sharp artwork and the others were generated separately at full resolution. See [the correction, sources, and new prompts](site-hero-resolution.md). The v1 hero atlas and poster remain as superseded assets and are not loaded by the site.

The following grid-packaging and prompt notes describe the original generation; they still apply to the three supporting scenes.

Generated PNG grids were split into equal cells for alignment and poster extraction, then encoded as WebP at quality 88. Whole-cell translations of at most five source pixels compensate for slight grid-placement drift, using white padding. No frame is scaled, warped, interpolated or blended during this registration. Generated textures still have some natural frame-to-frame variation.

Source sampling offsets (x, y), in frame order, against the first frame:

```json
{
  "hero": [
    [
      0,
      0
    ],
    [
      0,
      0
    ],
    [
      0,
      -2
    ],
    [
      0,
      -2
    ]
  ],
  "setup": [
    [
      0,
      0
    ],
    [
      -1,
      0
    ],
    [
      -2,
      0
    ],
    [
      -5,
      0
    ],
    [
      -1,
      -3
    ],
    [
      -1,
      -3
    ],
    [
      -2,
      -3
    ],
    [
      -5,
      -3
    ]
  ],
  "questions": [
    [
      0,
      0
    ],
    [
      0,
      0
    ],
    [
      0,
      0
    ],
    [
      0,
      0
    ],
    [
      0,
      -2
    ],
    [
      0,
      -1
    ],
    [
      -1,
      -1
    ],
    [
      0,
      -1
    ]
  ],
  "rest": [
    [
      0,
      0
    ],
    [
      -1,
      0
    ],
    [
      -1,
      0
    ],
    [
      -3,
      0
    ],
    [
      0,
      -2
    ],
    [
      -1,
      -2
    ],
    [
      -1,
      -2
    ],
    [
      -3,
      -2
    ]
  ]
}
```

## Generated masters

Retained in `/Users/lazim/.codex/generated_images/01a0ccec-f664-7e43-bfcf-afbe4fa7f43c/`:

- Hero: `exec-615fb4fc-97f4-4eff-bc0e-df80c558c526.png`.
- Setup: `exec-d99a19b0-4b66-457a-beaf-56c6503e5d25.png`.
- Questions: `exec-24838fee-b97f-4357-af53-a88614d9aa7f.png`.
- Footer: `exec-0c83cfa7-610f-4135-b9ec-4a3c4207f787.png`.

The first hero experiment, `exec-da8117a9-5b19-4e9c-82ba-22f63bfdea4f.png`, was not used. Its later cells returned prematurely to the starting pose, so a four-pose progression was generated instead.

## Exact prompts

### Hero

Reference: `site/assets/workshop-miniature-diverse.webp`.

```text
Use case: illustration-story.
Asset type: high-resolution FOUR-POSE animation spritesheet for OpenMerit's wide website hero.
Input image: identity/layout reference. Reproduce its complete miniature workshop faithfully.
Create exactly FOUR full-width frames in a TWO COLUMN by TWO ROW grid. Overall wide canvas aspect ratio 3:1, target 3456 x 1152 pixels. Each cell aspect ratio 3:1, target 1728 x 576. No gutters, lines, labels, captions or numbers. Every cell contains the entire original six-maker composition including dog and all furniture, at absolutely IDENTICAL camera, scale, layout, lighting and pixel coordinates. Reference original top whitespace and baseline. Static elements should be exact duplicates across cells; do not reinterpret each time.

The ONLY moving subject is the older seated South Asian maker with gray beard, glasses and mustard vest in the center-left. Preserve all other figures, their hands/tools, the balance scale, wood grain, benches, plant, dog, and shadows exactly unchanged in every cell.
Frame 1 top-left: original pose, both hand planes held low near his chest, gaze down.
Frame 2 top-right: right elbow bends, right hand raises the smaller hand plane halfway toward his face, gaze follows tool.
Frame 3 bottom-left: the small hand plane is just below eye level, he turns the rigid plane slightly to inspect its edge. Natural articulated elbow/wrist and intact five-finger grip.
Frame 4 bottom-right: the plane reaches eye level, with his right elbow bent comfortably and wrist tilted to view its sole. Left hand holds the other plane stationary. He is still seated, torso and feet planted.
Four successive actual stop-motion poses on the same set. Tools retain rigid shapes. Do not stretch, warp, liquify, wobble, blur, melt, crossfade or use motion trails. No change to identity, face, clothing or object inventory. Photographic handmade-miniature feel of reference; white background. Crisp detailed individual frames for use on a 1600px-wide webpage.
```

### setup

Reference: `site/assets/workshop-setup.webp`.

```text
Use case: illustration-story.
Asset type: production stop-motion animation spritesheet for a website.
Input image 1 is the identity, composition and photographic miniature material reference.
Create EXACTLY EIGHT sequential frames in ONE regular invisible grid, FOUR COLUMNS by TWO ROWS, left to right then next row. Target canvas 1536 x 512, every cell 384 x 256 (3:2).
Every frame has the COMPLETE scene, exact same scale, framing, camera, baseline, background, colors, shadows and object positions. No grid lines, borders, labels, lettering, arrows, gutters or numbers. No camera shake, zoom or crop changes. Opaque clean pure white background. Preserve reference characters and objects faithfully, not a redesign. This is an animation sequence of genuine new articulated poses, NOT image warping, breathing scale effects, liquify, stretching, melting or changes to the camera. Do not reset to starting pose halfway through. It will be played FORWARD THEN BACKWARD by code, so show the eight progressive poses of the ONE-WAY action below. Keep every rigid object solid and exactly the same shape. Do not add anything.
Scene: the weathered wooden toolbox containing the two hand planes, with brass calipers and folded linen in front. The box, tools, linen, calipers, and ground shadow are FIXED identically across all eight frames. Only the rigid lid rotates about its real back hinge. Its grain, brass clasp and rectangular shape stay identical. The hinge line stays precisely fixed.
Action sequence: frame1 lid fully upright open as reference (100 degrees from shut); frame2 96 degrees; frame3 87 degrees; frame4 75 degrees; frame5 60 degrees; frame6 45 degrees; frame7 32 degrees; frame8 25 degrees, almost closed but with clearance above the hand planes. Correct three-dimensional perspective as the lid rotates, physical wood thickness and hinge geometry. It must look like eight actual photographed stop-motion positions of the same wooden lid, not a flexible lid. Keep generous fixed whitespace above and identical box footprint in every cell.
```

### questions

Reference: `site/assets/workshop-questions.webp`.

```text
Use case: illustration-story.
Asset type: production stop-motion animation spritesheet for a website.
Input image 1 is the identity, composition and photographic miniature material reference.
Create EXACTLY EIGHT sequential frames in ONE regular invisible grid, FOUR COLUMNS by TWO ROWS, left to right then next row. Target canvas 1536 x 512, every cell 384 x 256 (3:2).
Every frame has the COMPLETE scene, exact same scale, framing, camera, baseline, background, colors, shadows and object positions. No grid lines, borders, labels, lettering, arrows, gutters or numbers. No camera shake, zoom or crop changes. Opaque clean pure white background. Preserve reference characters and objects faithfully, not a redesign. This is an animation sequence of genuine new articulated poses, NOT image warping, breathing scale effects, liquify, stretching, melting or changes to the camera. Do not reset to starting pose halfway through. It will be played FORWARD THEN BACKWARD by code, so show the eight progressive poses of the ONE-WAY action below. Keep every rigid object solid and exactly the same shape. Do not add anything.
Scene: the same Black woman with a high curly bun in indigo shirt and linen apron, and the seated older South Asian man in mustard vest and glasses, looking at a notebook on their oak table. Both full bodies, stool, table legs and all feet always visible.
Lock the table, notebook, pencil, stool, feet, head shapes, clothing, body position and scale IDENTICALLY throughout.
Action: woman moves her pointing RIGHT HAND across the open notebook from the left page toward the right page; elbow articulates slightly, rigid finger points. Older man gradually lowers his right hand from his chin and extends it toward the notebook to indicate a detail.
Eight progressive poses: 1 both original pose (woman points left page, man hand at chin); 2 woman's fingertip begins crossing, man's fingertips leave chin; 3 woman's fingertip quarter way across, man's hand below chin; 4 woman's fingertip half way across, man's elbow opens; 5 fingertip three quarters across, man's forearm reaching; 6 fingertip at fold, man's index finger extends; 7 woman indicates right page, man's fingertip above page; 8 both pointing at the right page, looking at the same place. Distinct realistic joint poses in each frame, correct five-finger anatomy and hand-object contact, no melted fingers. Small but legible motion. All static furniture and background must match pixel for pixel across cells.
```

### rest

Reference: `site/assets/workshop-rest.webp`.

```text
Use case: illustration-story.
Asset type: production stop-motion animation spritesheet for a website.
Input image 1 is the identity, composition and photographic miniature material reference.
Create EXACTLY EIGHT sequential frames in ONE regular invisible grid, FOUR COLUMNS by TWO ROWS, left to right then next row. Target canvas 1536 x 512, every cell 384 x 256 (3:2).
Every frame has the COMPLETE scene, exact same scale, framing, camera, baseline, background, colors, shadows and object positions. No grid lines, borders, labels, lettering, arrows, gutters or numbers. No camera shake, zoom or crop changes. Opaque clean pure white background. Preserve reference characters and objects faithfully, not a redesign. This is an animation sequence of genuine new articulated poses, NOT image warping, breathing scale effects, liquify, stretching, melting or changes to the camera. Do not reset to starting pose halfway through. It will be played FORWARD THEN BACKWARD by code, so show the eight progressive poses of the ONE-WAY action below. Keep every rigid object solid and exactly the same shape. Do not add anything.
Scene: the same brown-and-white spaniel lying curled with head on paws beside the CLOSED wooden toolbox and folded apron. Preserve the box, apron, dog's body, paws and contact shadows EXACTLY in all eight cells. Dog always in same place with full body visible. No scenery.
Action: the dog wakes and slowly raises its head to look toward the viewer. ONLY the head and neck articulate, with ears following naturally; back, paws, body, toolbox and apron stay still.
Eight progressive poses: 1 asleep with chin on paws; 2 eyes open a little, chin remains on paws; 3 eyes open, chin starts to lift; 4 chin raised a small distance, neck unfolding; 5 head half raised, gaze begins toward viewer; 6 head three quarters raised, ears hanging naturally; 7 head raised looking at viewer; 8 head fully raised comfortably while still LYING DOWN, eyes softly attentive, mouth closed. No sitting up, no wagging, no stretching, no changing body size or fur markings. Keep original framing with enough space for the raised head. This is photographed articulated stop motion; consistent face, nose, fur markings, head proportions and solid anatomy.
```
