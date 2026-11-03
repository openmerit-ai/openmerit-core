// Landing-page dividers drawn as slightly wiggly threads. A hovering pointer
// pulls the nearby part of the thread toward it; a damped spring then lets it
// lag behind, bounce a little and settle back into its resting wiggle.
const SPACING = 6; // px between simulated points
const REACH = 44; // px, horizontal spread of the pull around the pointer
const MAX_PULL = 7; // px, furthest the thread stretches from its rest line
const STIFFNESS = 140; // spring pulling each point toward its target, per s²
const TENSION = 900; // neighbours pulling each other into a smooth curve, per s²
const DAMPING = 9; // per s; low enough for a subtle bounce

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

document.querySelectorAll<HTMLElement>('.thread-rule').forEach((rule) => {
  const path = rule.querySelector<SVGPathElement>('path')!;
  const svg = path.ownerSVGElement!;
  let width = 0;
  let rest: number[] = [];
  let offset: number[] = [];
  let velocity: number[] = [];
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;
  let last = 0;

  function draw() {
    const mid = rule.clientHeight / 2;
    const y = rest.map((value, i) => mid + value + (offset[i] ?? 0));
    // Smooth curve through the midpoints, with each simulated point as a control point.
    const d = y.map((value, i) => {
      if (i === 0) return `M0 ${value.toFixed(2)}`;
      if (i === y.length - 1) return `L${width.toFixed(2)} ${value.toFixed(2)}`;
      return `Q${i * SPACING} ${value.toFixed(2)} ${(i + .5) * SPACING} ${((value + (y[i + 1] ?? value)) / 2).toFixed(2)}`;
    }).join(' ');
    path.setAttribute('d', d);
  }

  function resize() {
    width = rule.clientWidth;
    const count = Math.max(2, Math.round(width / SPACING) + 1);
    // A deterministic hand-drawn wobble: two incommensurate waves, about 1px tall.
    rest = Array.from({ length: count }, (_, i) => {
      const x = i * SPACING;
      return .7 * Math.sin(x / 9) + .35 * Math.sin(x / 3.7 + 1.3);
    });
    offset = new Array(count).fill(0);
    velocity = new Array(count).fill(0);
    svg.setAttribute('viewBox', `0 0 ${width} ${rule.clientHeight}`);
    draw();
    rule.classList.add('is-drawn');
  }

  function step(now: number) {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    let moving = pointer !== null;
    velocity = velocity.map((speed, i) => {
      const current = offset[i] ?? 0;
      let target = 0;
      if (pointer) {
        const distance = i * SPACING - pointer.x;
        const pull = Math.max(-MAX_PULL, Math.min(MAX_PULL, pointer.y * .7));
        target = pull * Math.exp(-(distance * distance) / (2 * REACH * REACH));
      }
      // Ends stay tied down like a thread pinned at both sides.
      const left = offset[i - 1] ?? 0;
      const right = offset[i + 1] ?? 0;
      const force = STIFFNESS * (target - current) + TENSION * (left + right - 2 * current) / 4 - DAMPING * speed;
      return speed + force * dt;
    });
    offset = offset.map((current, i) => {
      const next = current + (velocity[i] ?? 0) * dt;
      if (Math.abs(next) > .01 || Math.abs(velocity[i] ?? 0) > .01) moving = true;
      return next;
    });
    if (!moving) offset.fill(0);
    draw();
    frame = moving ? requestAnimationFrame(step) : 0;
  }

  function wake() {
    if (frame || reducedMotion.matches) return;
    last = performance.now();
    frame = requestAnimationFrame(step);
  }

  rule.addEventListener('pointermove', (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    const box = rule.getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top - box.height / 2 };
    wake();
  });
  rule.addEventListener('pointerleave', () => {
    pointer = null;
    wake();
  });
  new ResizeObserver(resize).observe(rule);
});
