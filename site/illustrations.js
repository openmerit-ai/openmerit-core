// Each image or atlas cell is a separately illustrated pose. Playback selects whole frames;
// it never distorts an image or interpolates between poses.
const scenes = [
  {
    selector: '.hero-art', source: 'hero', minimumWidth: 2172,
    frameUrls: [
      '/assets/motion/hero-frame-0-v2.webp',
      '/assets/motion/hero-frame-1-v2.webp',
      '/assets/motion/hero-frame-2-v2.webp',
      '/assets/motion/hero-frame-3-v2.webp',
    ],
    step: 180, rest: 1100, hold: 700,
  },
  { selector: '.setup-art', source: 'setup', columns: 4, rows: 2, step: 120, rest: 1400, hold: 600 },
  { selector: '.questions-art', source: 'questions', columns: 4, rows: 2, step: 140, rest: 1400, hold: 1000 },
  { selector: '.footer-art', source: 'rest', columns: 4, rows: 2, step: 180, rest: 2400, hold: 1600 },
];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionButton = document.querySelector('.motion-toggle');
let motionPaused = false;
try { motionPaused = localStorage.getItem('openmerit-motion-paused') === 'true'; } catch { /* Storage is optional. */ }

function makeSequence(scene) {
  const last = (scene.frameUrls?.length ?? scene.columns * scene.rows) - 1;
  const sequence = [{ frame: 0, duration: scene.rest }];
  for (let frame = 1; frame <= last; frame++) {
    sequence.push({ frame, duration: frame === last ? scene.hold : scene.step });
  }
  // Return through the drawn poses without a jump from the final pose to the first.
  for (let frame = last - 1; frame > 0; frame--) sequence.push({ frame, duration: scene.step });
  return sequence;
}

function drawFrame(scene, frame) {
  scene.context.clearRect(0, 0, scene.width, scene.height);
  if (scene.images) {
    scene.context.drawImage(scene.images[frame], 0, 0);
    return;
  }
  const x = (frame % scene.columns) * scene.width;
  const y = Math.floor(frame / scene.columns) * scene.height;
  scene.context.drawImage(scene.atlas, x, y, scene.width, scene.height, 0, 0, scene.width, scene.height);
}

async function loadFrame(source) {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();
  return image;
}

async function prepareScene(scene) {
  // The wide hero needs a full-size image per pose, not a quarter of one atlas.
  const images = scene.frameUrls ? await Promise.all(scene.frameUrls.map(loadFrame)) : null;
  const atlas = images ? null : await loadFrame(`/assets/motion/${scene.source}-sequence-v1.webp`);
  const width = images ? images[0].naturalWidth : atlas.naturalWidth / scene.columns;
  const height = images ? images[0].naturalHeight : atlas.naturalHeight / scene.rows;
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Invalid illustration frame dimensions');
  }
  if (images && (width < scene.minimumWidth || images.some(image => image.naturalWidth !== width || image.naturalHeight !== height))) {
    throw new Error('Illustration frames must retain their full, matching resolution');
  }

  const layer = document.createElement('canvas');
  layer.className = 'art-motion-layer';
  layer.width = width;
  layer.height = height;
  layer.hidden = true;
  layer.setAttribute('aria-hidden', 'true');
  const context = layer.getContext('2d');
  if (!context) throw new Error('Illustration canvas unavailable');
  Object.assign(scene, { images, atlas, layer, context, width, height });
  drawFrame(scene, 0);
  scene.figure.append(layer);
}

function canPlay(scene) {
  return scene.visible && !motionPaused && !reducedMotion.matches && !document.hidden;
}

function stopScene(scene) {
  clearTimeout(scene.timer);
  scene.timer = 0;
  // Pausing holds the current pose. Reduced motion always displays the static poster.
  if (reducedMotion.matches) {
    scene.cursor = 0;
    if (scene.layer) scene.layer.hidden = true;
  }
}

function advanceScene(scene) {
  scene.timer = 0;
  if (!canPlay(scene)) return;
  const { frame, duration } = scene.sequence[scene.cursor];
  drawFrame(scene, frame);
  scene.layer.hidden = false;
  scene.cursor = (scene.cursor + 1) % scene.sequence.length;
  // Wake only when a new pose is due. There is no per-refresh rendering loop.
  scene.timer = setTimeout(() => advanceScene(scene), duration);
}

async function playScene(scene) {
  if (!canPlay(scene) || scene.timer || scene.preparing || scene.failed) return;
  scene.preparing = true;
  try {
    scene.ready ??= prepareScene(scene);
    await scene.ready;
  } catch {
    // A failed frame load leaves the full-resolution first-frame poster intact.
    scene.failed = true;
    return;
  } finally {
    scene.preparing = false;
  }
  if (canPlay(scene)) advanceScene(scene);
}

function initIllustrations() {
  if (!('IntersectionObserver' in window) || !motionButton) return;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const scene = scenes.find(scene => scene.figure === entry.target);
      scene.visible = entry.isIntersecting && entry.intersectionRatio >= .18;
      if (scene.visible) playScene(scene);
      else stopScene(scene);
    }
  }, { threshold: [0, .18] });

  for (const scene of scenes) {
    scene.figure = document.querySelector(scene.selector);
    scene.sequence = makeSequence(scene);
    scene.cursor = 0;
    scene.timer = 0;
    if (scene.figure) observer.observe(scene.figure);
  }

  function syncPlayback() {
    motionButton.hidden = reducedMotion.matches;
    motionButton.textContent = motionPaused ? 'Resume motion' : 'Pause motion';
    motionButton.setAttribute('aria-label', motionPaused ? 'Resume illustration motion' : 'Pause illustration motion');
    scenes.forEach(scene => {
      if (canPlay(scene)) playScene(scene);
      else stopScene(scene);
    });
  }
  motionButton.addEventListener('click', () => {
    motionPaused = !motionPaused;
    try { localStorage.setItem('openmerit-motion-paused', String(motionPaused)); } catch { /* Storage is optional. */ }
    syncPlayback();
  });
  reducedMotion.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', syncPlayback);
  window.addEventListener('pageshow', syncPlayback);
  syncPlayback();
}

initIllustrations();
