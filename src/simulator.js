import { BANDS, SPEED_OF_SOUND, makeChirp, rangeResolution } from './chirp.js';
import { PingAnalyzer } from './ranging.js';
import { DEFAULTS } from './sonar.js';

/**
 * A stand-in for Sonar that invents a room instead of listening to one.
 *
 * It synthesises received audio and pushes it through the *real* PingAnalyzer,
 * so what reaches the display has been through the same matched filter, CFAR
 * and peak detection as live audio would be. Useful for working on the
 * interface without a microphone, and for seeing what a clean signal is
 * supposed to look like before blaming the room.
 */

// Stand-in for an iPad with landscape stereo: speakers at opposite ends, and
// the mic nearer one of them.
const SPEAKER_SEPARATION = 0.22; // metres
const SECOND_SPEAKER_DIRECT_EXTRA = 0.20; // metres further from the mic

const ROOM = {
  // A 5 x 4 m room with the listener a bit off-centre, plus two obstacles.
  width: 5, height: 4, x: 2.2, y: 1.6,
  boxes: [
    { x: 3.6, y: 0.5, w: 1.0, h: 0.6 },  // a desk
    { x: 0.4, y: 2.6, w: 0.6, h: 1.0 },  // a cupboard
  ],
};

/** Distance from a point to the first surface along a bearing. */
export function castRay(room, px, py, bearing, maxRange) {
  // Screen bearing: 0 is "up" the room (+y), increasing clockwise.
  const dx = Math.sin(bearing);
  const dy = Math.cos(bearing);
  let best = Infinity;

  const slab = (lo, hi, p, d) => {
    if (Math.abs(d) < 1e-9) return p >= lo && p <= hi ? [-Infinity, Infinity] : null;
    const t1 = (lo - p) / d, t2 = (hi - p) / d;
    return [Math.min(t1, t2), Math.max(t1, t2)];
  };

  // Outer walls: nearest positive exit of the room box.
  const sx = slab(0, room.width, px, dx);
  const sy = slab(0, room.height, py, dy);
  if (sx && sy) {
    const exit = Math.min(sx[1], sy[1]);
    if (exit > 0) best = Math.min(best, exit);
  }

  // Obstacles: nearest positive entry.
  for (const b of room.boxes) {
    const bx = slab(b.x, b.x + b.w, px, dx);
    const by = slab(b.y, b.y + b.h, py, dy);
    if (!bx || !by) continue;
    const enter = Math.max(bx[0], by[0]);
    const exit = Math.min(bx[1], by[1]);
    if (enter <= exit && exit > 0 && enter > 0) best = Math.min(best, enter);
  }
  return Math.min(best, maxRange);
}

export class SimulatedSonar {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.state = 'idle';
    this.onProfile = null;
    this.onStatus = null;
    this.seq = 0;
    this.sampleRate = 48000;
    this.getBearing = () => 0;
    this.simulated = true;
    this.room = ROOM;
    this.outputChannels = 2;
  }

  get band() { return BANDS[this.opts.band] ?? BANDS.balanced; }
  get resolution() { const b = this.band; return rangeResolution(b.f1 - b.f0); }
  get calibrated() { return !!this.analyzer?.clutter; }

  _status(msg, extra = {}) { this.onStatus?.({ state: this.state, message: msg, ...extra }); }

  async start() {
    this._build();
    this.state = 'running';
    this._status('Simulated room — no microphone in use', { simulated: true });
    this.timer = setInterval(() => this._ping(), 1000 / this.opts.pingRate);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
    this._status('Stopped');
  }

  set(key, value) {
    this.opts[key] = value;
    if (['band', 'chirpMs', 'maxRange', 'speakerMic', 'blindRange'].includes(key)) this._build();
    if (key === 'speaker') this._status(`Simulating ${key === 'speaker' && value === 'both' ? 'both speakers' : 'a single speaker'}`);
    if (key === 'cfarScale' && this.analyzer) this.analyzer.cfarScale = value;
    if (key === 'pingRate' && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this._ping(), 1000 / value);
    }
  }

  calibrate(pings = 24) {
    // Nothing to learn from a simulated device, but keep the interface honest.
    return new Promise((resolve) => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        this._status(`Calibrating… ${n}/${pings}`, { calibrating: n / pings });
        if (n >= pings) {
          clearInterval(t);
          const secondaryPulse = this.opts.speaker === 'both'
            ? {
                lagSamples: SECOND_SPEAKER_DIRECT_EXTRA * (this.sampleRate / SPEED_OF_SOUND),
                pathMetres: SECOND_SPEAKER_DIRECT_EXTRA,
                rangeBias: SECOND_SPEAKER_DIRECT_EXTRA / 2,
                ratio: 1,
              }
            : null;
          this.lastCalibration = { pings, referenceLength: 0, secondaryPulse };
          this._status('Calibrated', { calibrated: true });
          resolve(this.lastCalibration);
        }
      }, 1000 / this.opts.pingRate);
    });
  }

  clearCalibration() { this._status('Calibration cleared'); }

  _build() {
    const b = this.band;
    this.chirp = makeChirp({
      sampleRate: this.sampleRate, f0: b.f0, f1: b.f1,
      duration: this.opts.chirpMs / 1000, taper: 0.3,
    });
    this.analyzer = new PingAnalyzer({
      sampleRate: this.sampleRate, chirp: this.chirp, f0: b.f0, f1: b.f1,
      maxRange: this.opts.maxRange, speakerMic: this.opts.speakerMic,
      blindRange: this.opts.blindRange, cfarScale: this.opts.cfarScale,
    });
  }

  _ping() {
    const a = this.analyzer;
    const sr = this.sampleRate;
    const bearing = this.getBearing();
    const rx = new Float32Array(a.windowLength);

    const add = (at, amp) => {
      const i0 = Math.round(at);
      for (let i = 0; i < this.chirp.length; i++) {
        const j = i0 + i;
        if (j >= 0 && j < rx.length) rx[j] += amp * this.chirp[i];
      }
    };

    // Keep well clear of full scale: a simulated ping that pins the input
    // would trip the clipping warning the real path uses.
    // Model both speakers when the user asks for both, so the demo shows the
    // doubled echoes and the rival direct blast rather than just describing them.
    const both = this.opts.speaker === 'both';
    const perMetre = sr / SPEED_OF_SOUND;

    // Split the level across the speakers rather than doubling it, matching
    // what a mono buffer fanned out to two channels actually does.
    const drive = both ? 0.45 : 0.6;
    add(a.preGuard, drive);
    if (both) add(a.preGuard + SECOND_SPEAKER_DIRECT_EXTRA * perMetre, drive);

    // The beam is wide, so sample a fan of rays rather than a single one.
    const half = 22 * Math.PI / 180;
    for (let k = -2; k <= 2; k++) {
      const th = bearing + (k / 2) * half;
      const r = castRay(this.room, this.room.x, this.room.y, th, this.opts.maxRange * 1.2);
      if (!isFinite(r) || r > this.opts.maxRange) continue;
      const lag = ((2 * r - this.opts.speakerMic) / SPEED_OF_SOUND) * sr;
      const amp = (drive / 0.6) * 0.17 / (1 + 3 * r * r) * (1 - 0.35 * Math.abs(k) / 2);
      add(a.preGuard + lag, amp);
      if (both) {
        // In the far field the second speaker's extra path is the projection of
        // the speaker separation onto the bearing, so the ghost slides in and
        // out as the device turns.
        const extra = SPEAKER_SEPARATION * Math.cos(th);
        add(a.preGuard + lag + extra * perMetre, amp);
      }
    }

    for (let i = 0; i < rx.length; i++) rx[i] += 0.00055 * (Math.random() * 2 - 1);

    const profile = a.analyze(rx, { cancel: false });
    if (profile.error) return;
    profile.seq = this.seq++;
    profile.time = performance.now();
    profile.simulated = true;
    this.onProfile?.(profile);
  }
}
