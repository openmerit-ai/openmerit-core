// Animate small regions of the existing artwork; the original images remain the fallback.
// Coordinates are fractions of each source image. Fields fade to zero before any seam.
const scenes = [
  {
    selector: '.hero-art',
    rest: 6500,
    gestures: [
      { // The maker looks down to check the calipers.
        fields: [[.273, .397, .052, .17, -.25, -.8]],
        strength: 7, delay: 100, duration: 2600,
      },
      { // The two brass pans find their balance, with a smaller return swing.
        fields: [[.516, .563, .019, .046, 0, 1], [.552, .563, .019, .046, 0, -1]],
        strength: 7, delay: 400, duration: 3200,
        beats: [[0, 0], [.25, 1], [.58, -.32], [.82, .1], [1, 0]],
      },
      { // A later, independent movement from the maker comparing planes.
        fields: [[.429, .467, .049, .16, .3, -.7]],
        strength: 6, delay: 1450, duration: 2600,
      },
    ],
  },
  {
    selector: '.setup-art',
    rest: 11000,
    gestures: [{
      // The open lid settles about its hinge; the chest and tools stay grounded.
      fields: [[.335, .255, .25, .2, 0, 1]],
      strength: 12, delay: 100, duration: 2200,
      beats: [[0, 0], [.38, 1], [.72, -.12], [1, 0]],
    }],
  },
  {
    selector: '.questions-art',
    rest: 9500,
    gestures: [
      { // A small nod toward the shared notebook.
        fields: [[.403, .172, .13, .17, -.18, -.85]],
        strength: 8, delay: 100, duration: 2200,
      },
      {
        fields: [[.617, .26, .108, .15, .2, -.65]],
        strength: 7, delay: 700, duration: 2400,
      },
    ],
  },
  {
    selector: '.footer-art',
    rest: 3200,
    gestures: [{
      // An unhurried breath through the dog's back. Head, paws, and toolbox stay still.
      fields: [[.238, .567, .17, .16, 0, 1]],
      strength: 16, delay: 150, duration: 4200,
      beats: [[0, 0], [.38, 1], [.5, 1], [1, 0]],
    }],
  },
];

const svgNamespace = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const gentleBeats = [[0, 0], [.4, 1], [.58, .9], [1, 0]];
const motionButton = document.querySelector('.motion-toggle');
let motionPaused = false;
try { motionPaused = localStorage.getItem('openmerit-motion-paused') === 'true'; } catch { /* Storage is optional. */ }

function svgElement(name, attributes) {
  const element = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function sampleGesture(progress, beats) {
  const next = beats.findIndex(([at]) => at >= progress);
  if (next <= 0) return 0;
  const [from, start] = beats[next - 1];
  const [to, end] = beats[next];
  const eased = (1 - Math.cos(Math.PI * (progress - from) / (to - from))) / 2;
  return start + (end - start) * eased;
}

async function prepareScene(scene, index) {
  await scene.image.decode();
  const width = scene.image.naturalWidth;
  const height = scene.image.naturalHeight;
  const layer = svgElement('svg', {
    class: 'art-motion-layer', viewBox: `0 0 ${width} ${height}`,
    'aria-hidden': 'true', focusable: 'false', hidden: '',
  });
  const definitions = svgElement('defs', {});
  layer.append(definitions);

  await Promise.all(scene.gestures.map(async (gesture, gestureIndex) => {
    const id = `art-motion-${index}-${gestureIndex}`;
    const left = Math.max(0, Math.floor(Math.min(...gesture.fields.map(([x, , rx]) => x - rx)) * width) - 2);
    const top = Math.max(0, Math.floor(Math.min(...gesture.fields.map(([, y, , ry]) => y - ry)) * height) - 2);
    const right = Math.min(width, Math.ceil(Math.max(...gesture.fields.map(([x, , rx]) => x + rx)) * width) + 2);
    const bottom = Math.min(height, Math.ceil(Math.max(...gesture.fields.map(([, y, , ry]) => y + ry)) * height) + 2);
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };

    // A smooth vector field moves a head or the dog's back without cutting out the
    // subject. Neutral grey leaves every other pixel at its original position.
    const gradients = gesture.fields.map(([, , , , dx, dy], i) =>
      `<radialGradient id="g${i}"><stop offset="0" stop-color="rgb(${128 + dx * 127},${128 + dy * 127},128)"/><stop offset=".3" stop-color="rgb(${128 + dx * 127},${128 + dy * 127},128)"/><stop offset="1" stop-color="rgb(128,128,128)"/></radialGradient>`).join('');
    const fields = gesture.fields.map(([x, y, rx, ry], i) =>
      `<ellipse cx="${x * width - left}" cy="${y * height - top}" rx="${rx * width}" ry="${ry * height}" fill="url(#g${i})"/>`).join('');
    const mapSource = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="${svgNamespace}" width="${bounds.width}" height="${bounds.height}"><defs>${gradients}</defs><rect width="100%" height="100%" fill="rgb(128,128,128)"/>${fields}</svg>`)}`;
    const map = new Image();
    map.src = mapSource;
    await map.decode();

    const filter = svgElement('filter', {
      id, ...bounds, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB',
    });
    filter.append(svgElement('feImage', { ...bounds, href: mapSource, result: 'motion-map' }));
    // Correct the 8-bit grey midpoint so patch edges remain exactly stationary.
    const midpoint = svgElement('feComponentTransfer', { in: 'motion-map', result: 'centered-map' });
    for (const channel of ['R', 'G']) {
      midpoint.append(svgElement(`feFunc${channel}`, { type: 'linear', slope: 1, intercept: -1 / 510 }));
    }
    filter.append(midpoint);
    gesture.displacement = svgElement('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'centered-map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G',
    });
    filter.append(gesture.displacement);
    definitions.append(filter);
    layer.append(svgElement('image', {
      href: scene.image.currentSrc || scene.image.src, width, height, filter: `url(#${id})`,
    }));
  }));
  scene.layer = layer;
  scene.figure.append(layer);
}

function stopScene(scene) {
  cancelAnimationFrame(scene.frame);
  clearTimeout(scene.timer);
  scene.frame = 0;
  scene.timer = 0;
  scene.figure.classList.remove('art-entering');
  scene.layer?.setAttribute('hidden', '');
  for (const gesture of scene.gestures) gesture.displacement?.setAttribute('scale', 0);
}

function canPlay(scene) {
  return scene.visible && !motionPaused && !reducedMotion.matches && !document.hidden;
}

function scheduleScene(scene, index, delay = 450) {
  if (!canPlay(scene) || scene.frame || scene.timer || scene.preparing) return;
  scene.timer = setTimeout(() => {
    scene.timer = 0;
    playScene(scene, index);
  }, delay);
}

async function playScene(scene, index) {
  if (!canPlay(scene) || scene.frame || scene.preparing) return;
  scene.preparing = true;
  try {
    scene.ready ??= prepareScene(scene, index);
    await scene.ready;
  } catch {
    // A failed image/filter load leaves the original static illustration intact.
    return;
  } finally {
    scene.preparing = false;
  }
  if (!canPlay(scene)) return;
  if (!scene.hasPlayed) scene.figure.classList.add('art-entering');
  scene.hasPlayed = true;
  scene.layer.removeAttribute('hidden');
  const duration = Math.max(...scene.gestures.map(gesture => gesture.delay + gesture.duration));
  const start = performance.now();
  let lastPaint = -Infinity;

  function render(now) {
    const elapsed = now - start;
    if (!canPlay(scene)) {
      stopScene(scene);
      return;
    }
    if (elapsed >= duration) {
      stopScene(scene);
      scheduleScene(scene, index, scene.rest);
      return;
    }
    // These very small painted effects need only 30 updates/second, even on 120Hz screens.
    if (now - lastPaint >= 1000 / 30 - .5) {
      lastPaint = now;
      for (const gesture of scene.gestures) {
        const progress = Math.max(0, Math.min(1, (elapsed - gesture.delay) / gesture.duration));
        const amount = sampleGesture(progress, gesture.beats || gentleBeats);
        const scale = (amount * gesture.strength).toFixed(3);
        if (gesture.displacement.getAttribute('scale') !== scale) gesture.displacement.setAttribute('scale', scale);
      }
    }
    scene.frame = requestAnimationFrame(render);
  }
  scene.frame = requestAnimationFrame(render);
}

function initIllustrations() {
  if (!('IntersectionObserver' in window) || !('SVGFEImageElement' in window)) return;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const index = scenes.findIndex(scene => scene.figure === entry.target);
      const scene = scenes[index];
      scene.visible = entry.isIntersecting && entry.intersectionRatio >= .18;
      if (!scene.visible) stopScene(scene);
      else scheduleScene(scene, index);
    }
  }, { threshold: [0, .18] });

  for (const scene of scenes) {
    scene.figure = document.querySelector(scene.selector);
    scene.image = scene.figure.querySelector('img');
    observer.observe(scene.figure);
  }

  function syncPlayback() {
    motionButton.hidden = reducedMotion.matches;
    motionButton.textContent = motionPaused ? 'Resume motion' : 'Pause motion';
    motionButton.setAttribute('aria-label', motionPaused ? 'Resume illustration motion' : 'Pause illustration motion');
    scenes.forEach((scene, index) => {
      if (!canPlay(scene)) stopScene(scene);
      else scheduleScene(scene, index);
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
