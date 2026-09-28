// Playback never calls a provider or creates a sandbox. Its data is an exported run.
export class Playback {
  constructor(recording) {
    this.recording = recording;
    this.elapsed = 0;
    this.playing = true;
  }
  get frameIndex() {
    return this.recording.frames.findLastIndex(frame => frame.at <= this.elapsed);
  }
  get complete() { return this.elapsed >= this.recording.duration; }
  advance(seconds) {
    if (!this.playing) return;
    this.seek(this.elapsed + Math.max(0, seconds));
  }
  seek(seconds) {
    this.elapsed = Math.max(0, Math.min(this.recording.duration, Number(seconds) || 0));
    if (this.complete) this.playing = false;
  }
  toggle() {
    if (this.complete) this.elapsed = 0;
    this.playing = !this.playing;
  }
  reset(autoplay = false) { this.elapsed = 0; this.playing = autoplay; }
}

export function recordedView(recording, frameIndex) {
  const frame = recording.frames[Math.max(0, frameIndex)];
  const changed = ['applied', 'verified', 'complete'].includes(frame.phase);
  const verified = ['verified', 'complete'].includes(frame.phase);
  const batches = Object.fromEntries(frame.measured.map(key => [key, recording.measurements[key]]));
  return {
    phase: frame.phase, batches,
    before: batches.baseline,
    after: changed ? batches[recording.selectedMeasurement ?? 'trial-2'] : batches.baseline,
    changed, verified,
    output: verified ? recording.example : null,
    lines: recording.frames.slice(0, frameIndex + 1),
  };
}
