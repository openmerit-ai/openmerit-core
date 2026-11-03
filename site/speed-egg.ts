// Easter egg, a nod to Need for Speed: hovering "needs for speed" spirals the
// words off into the distance while a little car races through the gap, and
// each word springs back as the car passes it. Nothing hints at it until hovered.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const CAR = `<svg class="speed-car" viewBox="-24 0 72 18" aria-hidden="true">
  <path class="speed-lines" d="M-22 6h13M-17 10h10M-23 14h14"/>
  <path class="speed-body" d="M1 13.5V11c0-1.6 1-2.6 2.6-2.9L12 6.6l5.6-3.3C19 2.5 20.6 2 22.3 2h7.2c1.8 0 3.4.7 4.6 2l3.4 3.4 6 1.1c1.6.3 2.5 1.4 2.5 3v2Z"/>
  <path class="speed-window" d="M18.5 6.8l2.3-2.3c.6-.6 1.4-.9 2.3-.9h5.8c1 0 1.9.4 2.6 1.1l2.1 2.1Z"/>
  <circle cx="11" cy="14" r="3.2"/><circle cx="37" cy="14" r="3.2"/>
</svg>`;
// Emil Kowalski's strong curves: ease-out for leaving, ease-in-out for moving across.
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';
const SPIN_OUT = 440; // ms
const STAGGER = 40; // ms between words
const CAR_START = 140; // ms
const CAR_RUN = 620; // ms

// A spring (perceptual duration 0.6s, bounce 0.3) sampled into CSS linear(),
// so the words overshoot a touch and settle instead of stopping dead.
const SPRING_MS = 900;
const spring = (() => {
  const zeta = 1 - .3;
  const omega = 2 * Math.PI / .6;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const points = Array.from({ length: 61 }, (_, i) => {
    const t = i / 60 * SPRING_MS / 1000;
    const decay = Math.exp(-zeta * omega * t);
    return 1 - decay * (Math.cos(damped * t) + zeta * omega / damped * Math.sin(damped * t));
  });
  points[60] = 1;
  const linear = `linear(${points.map((value) => value.toFixed(4)).join(', ')})`;
  return CSS.supports('animation-timing-function', linear) ? linear : EASE_OUT;
})();

document.querySelectorAll<HTMLElement>('.speed-egg').forEach((phrase) => {
  // Each word becomes its own inline-block so it can spin; the spaces between
  // them stay ordinary text, so the line wraps exactly as before.
  const words = (phrase.textContent ?? '').split(' ').map((word) => {
    const span = document.createElement('span');
    span.className = 'speed-word';
    span.textContent = word;
    return span;
  });
  phrase.replaceChildren(...words.flatMap((span, i) => (i ? [' ', span] : [span])));
  phrase.insertAdjacentHTML('beforeend', CAR);
  const car = phrase.querySelector<SVGElement>('.speed-car')!;
  let running = false;

  phrase.addEventListener('pointerenter', (event: PointerEvent) => {
    if (event.pointerType === 'touch' || reducedMotion.matches || running) return;
    // The car drives along the phrase's first line, even when it wraps.
    const line = phrase.getClientRects()[0];
    if (!line) return;
    running = true;
    const run = line.width - 58;
    const animations = [car.animate([
      { transform: 'translateX(-12px) skewX(0deg)', opacity: 0 },
      { opacity: 1, offset: .12 },
      { transform: `translateX(${(run - 12) / 2}px) skewX(-14deg)`, opacity: 1, offset: .5 },
      { opacity: 1, offset: .88 },
      { transform: `translateX(${run}px) skewX(-5deg)`, opacity: 0 },
    ], { duration: CAR_RUN, delay: CAR_START, easing: EASE_IN_OUT, fill: 'both' })];

    words.forEach((word, i) => {
      // Every word spirals around one vanishing point at the middle of the line.
      const box = word.getBoundingClientRect();
      word.style.transformOrigin = `${line.left + line.width / 2 - box.left}px ${line.top + line.height / 2 - box.top}px`;
      const away = { transform: `rotate(${250 + i * 45}deg) scale(.2)`, opacity: 0, filter: 'blur(2px)' };
      const home = { transform: 'rotate(0deg) scale(1)', opacity: 1, filter: 'blur(0px)' };
      // Send it home just as the car passes it.
      const passed = Math.min(1, Math.max(0, (box.left + box.width / 2 - line.left) / line.width));
      animations.push(
        word.animate([home, away], { duration: SPIN_OUT, delay: i * STAGGER, easing: EASE_OUT, fill: 'forwards' }),
        word.animate([away, { opacity: 1, offset: .25 }, home], { duration: SPRING_MS, delay: CAR_START + CAR_RUN * (.3 + .55 * passed), easing: spring, fill: 'forwards' }),
      );
    });

    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      animations.forEach((animation) => animation.cancel());
      words.forEach((word) => word.style.removeProperty('transform-origin'));
      running = false;
    });
  });
});
