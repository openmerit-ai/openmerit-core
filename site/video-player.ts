const player = document.querySelector<HTMLElement>('#intro-player')!;
const video = player.querySelector<HTMLVideoElement>('video')!;
const cover = player.querySelector<HTMLButtonElement>('.film-cover')!;
const controls = player.querySelector<HTMLElement>('.film-controls')!;
const play = player.querySelector<HTMLButtonElement>('.film-play')!;
const mute = player.querySelector<HTMLButtonElement>('.film-mute')!;
const seek = player.querySelector<HTMLInputElement>('.film-progress')!;
const preview = player.querySelector<HTMLElement>('.film-seek-preview')!;
const speed = player.querySelector<HTMLDetailsElement>('.film-speed')!;
const speedToggle = speed.querySelector<HTMLElement>('summary')!;
const fullscreen = player.querySelector<HTMLButtonElement>('.film-fullscreen')!;
const current = player.querySelector<HTMLElement>('.film-current')!;
const duration = player.querySelector<HTMLElement>('.film-duration')!;
const status = player.querySelector<HTMLElement>('.film-status')!;

function timestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function update() {
  const length = Number.isFinite(video.duration) ? video.duration : 52.86;
  const playing = !video.paused && !video.ended;
  player.classList.toggle('is-playing', playing);
  player.classList.toggle('is-muted', video.muted || video.volume === 0);
  cover.hidden = playing;
  play.setAttribute('aria-label', playing ? 'Pause' : video.ended ? 'Replay' : 'Play');
  cover.setAttribute('aria-label', video.ended ? 'Replay the OpenMerit introduction' : 'Play the OpenMerit introduction');
  mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  seek.max = String(length);
  seek.value = String(video.currentTime);
  seek.style.setProperty('--progress', `${video.currentTime / length * 100}%`);
  current.textContent = timestamp(video.currentTime);
  duration.textContent = timestamp(Math.ceil(length));
  seek.setAttribute('aria-valuetext', `${timestamp(video.currentTime)} of ${timestamp(Math.ceil(length))}`);
}

async function togglePlayback() {
  if (!video.paused) {
    video.pause();
    return;
  }
  status.textContent = '';
  if (document.activeElement === cover) play.focus({ preventScroll: true });
  try {
    await video.play();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    status.textContent = 'Playback couldn’t start. Please try again, or open the video below.';
    showFallback();
  }
}

function showFallback() {
  if (status.querySelector('a')) return;
  const link = document.createElement('a');
  link.href = video.querySelector('source')!.src;
  link.textContent = 'Open video';
  status.append(' ', link);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (player.requestFullscreen) await player.requestFullscreen();
    else {
      // iPhone Safari provides native video fullscreen rather than element fullscreen.
      const native = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
      native.webkitEnterFullscreen?.();
    }
  } catch {
    status.textContent = 'Fullscreen is unavailable in this browser.';
  }
}

cover.addEventListener('click', togglePlayback);
play.addEventListener('click', togglePlayback);
video.addEventListener('click', togglePlayback);
mute.addEventListener('click', () => { video.muted = !video.muted; });
speed.addEventListener('change', event => {
  if (!(event.target instanceof HTMLInputElement)) return;
  video.playbackRate = Number(event.target.value);
  speedToggle.textContent = `${event.target.value}×`;
  speedToggle.setAttribute('aria-label', `Playback speed, ${event.target.value}×`);
  speed.open = false;
  speedToggle.focus({ preventScroll: true });
});
speed.addEventListener('toggle', () => {
  if (speed.open) speed.querySelector<HTMLInputElement>(':checked')!.focus({ preventScroll: true });
});
speed.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  speed.open = false;
  speedToggle.focus({ preventScroll: true });
});
document.addEventListener('pointerdown', event => {
  if (event.target instanceof Node && !speed.contains(event.target)) speed.open = false;
});
seek.addEventListener('pointermove', event => {
  if (event.pointerType !== 'mouse') return;
  const bounds = seek.getBoundingClientRect();
  const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  preview.textContent = timestamp(position * Number(seek.max));
  preview.style.setProperty('--preview-position', `${position * 100}%`);
  preview.hidden = false;
});
seek.addEventListener('pointerleave', () => { preview.hidden = true; });
seek.addEventListener('input', () => {
  video.currentTime = Number(seek.value);
  update();
});
fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  fullscreen.setAttribute('aria-label', document.fullscreenElement === player ? 'Exit fullscreen' : 'Enter fullscreen');
});
for (const event of ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'volumechange']) {
  video.addEventListener(event, update);
}
video.addEventListener('waiting', () => { status.textContent = 'Loading video…'; });
video.addEventListener('playing', () => { status.textContent = ''; });
video.addEventListener('pause', () => {
  if (status.textContent === 'Loading video…') status.textContent = '';
});
function mediaError() {
  video.pause();
  update();
  status.textContent = 'The video couldn’t load. Please try opening it directly.';
  showFallback();
}
video.addEventListener('error', mediaError);
video.querySelector('source')!.addEventListener('error', mediaError);
player.addEventListener('keydown', event => {
  if (event.target instanceof Element && event.target.closest('button, input, summary, a')) return;
  switch (event.key.toLowerCase()) {
    case ' ':
    case 'k': event.preventDefault(); void togglePlayback(); break;
    case 'arrowleft': event.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); break;
    case 'arrowright': event.preventDefault(); video.currentTime = Math.min(video.duration || 52.86, video.currentTime + 5); break;
    case 'm': event.preventDefault(); video.muted = !video.muted; break;
    case 'f': event.preventDefault(); void toggleFullscreen(); break;
  }
});

// Native controls remain available when JavaScript cannot load.
video.controls = false;
controls.hidden = false;
update();
