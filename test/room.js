// A crude but honest acoustic model of "iPad in a room", used to drive the
// ranging chain end to end without hardware.
//
// The part that matters is the split between two impulse responses:
//
//   hDirect - what the mic hears straight from the speaker. Includes the
//             speaker's own colouration *and* a long ringing tail from the
//             case, because the two are mechanically coupled. This tail is the
//             thing that hides nearby walls.
//   hEcho   - what comes back off a surface. Same speaker colouration, but no
//             structural ringing, since that path is through the air.
//
// Both are deterministic, which is what makes the calibrated canceller able to
// remove the first one. That mirrors reality: the device's own signature
// repeats ping to ping, the room does not.

import { SPEED_OF_SOUND } from '../src/chirp.js';

/** Speaker/mic colouration: a short, slightly resonant response. */
export function speakerResponse(sampleRate) {
  const n = Math.round(0.0008 * sampleRate);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    h[i] = Math.exp(-t * 4000) * Math.cos(2 * Math.PI * 5200 * t);
  }
  h[0] += 1;
  return h;
}

/** Structural ringdown that follows the direct blast, decaying over ~3 ms. */
export function ringdown(sampleRate, { amp = 0.08, tau = 0.003, freq = 7000 } = {}) {
  const n = Math.round(tau * 6 * sampleRate);
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    h[i] = amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * freq * t);
  }
  return h;
}

function convolve(x, h) {
  const out = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    for (let j = 0; j < h.length; j++) out[i + j] += xi * h[j];
  }
  return out;
}

/** Deterministic PRNG so a failing test reproduces exactly. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class Room {
  /**
   * @param {object} o
   * @param {number[]} o.walls ranges in metres
   * @param {number} o.speakerMic metres between speaker and mic
   */
  constructor({ sampleRate, chirp, speakerMic = 0.15, walls = [], noise = 0.0008, seed = 7, ringAmp = 0.08 }) {
    this.sampleRate = sampleRate;
    this.chirp = chirp;
    this.speakerMic = speakerMic;
    this.walls = walls;
    this.noise = noise;
    this.rand = rng(seed);

    const spk = speakerResponse(sampleRate);
    const ring = ringdown(sampleRate, { amp: ringAmp });

    // Direct path = speaker colouration followed by the case ringing.
    const hDirect = new Float64Array(Math.max(spk.length, ring.length));
    for (let i = 0; i < spk.length; i++) hDirect[i] += spk[i];
    for (let i = 0; i < ring.length; i++) hDirect[i] += ring[i];

    this.directPulse = convolve(chirp, hDirect);
    this.echoPulse = convolve(chirp, spk);
  }

  /** Round-trip lag in samples, relative to the direct blast, for a wall. */
  lagFor(rangeM) {
    return (((2 * rangeM - this.speakerMic) / SPEED_OF_SOUND) * this.sampleRate);
  }

  /**
   * Record one ping.
   * @param {number} length window length in samples
   * @param {number} directAt index of the direct blast
   * @param {{walls?: number[], gain?: number}} o override the room for this ping
   */
  record(length, directAt, { walls = this.walls, gain = 1 } = {}) {
    const rx = new Float32Array(length);
    const add = (pulse, at, amp) => {
      const i0 = Math.round(at);
      for (let i = 0; i < pulse.length; i++) {
        const j = i0 + i;
        if (j >= 0 && j < length) rx[j] += amp * pulse[i];
      }
    };

    add(this.directPulse, directAt, gain);
    for (const w of walls) {
      const r = typeof w === 'number' ? w : w.range;
      const reflect = typeof w === 'number' ? 0.5 : (w.reflectivity ?? 0.5);
      // Spherical spreading over the round trip, plus a sign flip on some
      // surfaces. Magnitude detection shouldn't care about the sign.
      const amp = gain * reflect / (1 + 4 * r * r) * (this.rand() < 0.3 ? -1 : 1);
      add(this.echoPulse, directAt + this.lagFor(r), amp);
    }

    if (this.noise > 0) {
      for (let i = 0; i < length; i++) rx[i] += this.noise * (this.rand() * 2 - 1);
    }
    return rx;
  }
}
