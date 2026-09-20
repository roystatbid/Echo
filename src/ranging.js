import { nextPow2 } from './fft.js';
import { SPEED_OF_SOUND } from './chirp.js';

/**
 * Smallest compressed direct blast we will believe, as a fraction of full
 * scale. The filter is normalised so a received copy of amplitude `a` peaks at
 * `a`, so this is about -54 dBFS: far below any usable ping, far above the
 * numerical grass of a silent input.
 */
export const MIN_DIRECT_LEVEL = 0.002;
import {
  MatchedFilter, magnitude, argMax, parabolicPeak,
  cfarThreshold, detectPeaks, medianOf, phaseShift, toDb,
} from './dsp.js';

/**
 * Turns one recorded window into a range profile.
 *
 * Kept free of Web Audio so the whole ranging chain can be driven from a
 * simulated room in tests instead of only being observable on the device.
 *
 * The window is expected to start `preGuard` samples before the direct
 * speaker-to-mic blast. That blast is the time origin: measuring echoes
 * relative to it cancels out the entire unknown output-to-input latency of the
 * audio stack, which is large, device-specific, and changes when the route
 * changes.
 */
export class PingAnalyzer {
  constructor({
    sampleRate,
    chirp,
    f0,
    f1,
    maxRange = 6,
    speakerMic = 0.15,
    blindRange = 0.25,
    cfarScale = 4.5,
    preGuardSec = 0.002,
    tailSec = 0.002,
  }) {
    this.sampleRate = sampleRate;
    this.chirp = chirp;
    this.f0 = f0;
    this.f1 = f1;
    this.centreFreq = (f0 + f1) / 2;
    this.maxRange = maxRange;
    this.speakerMic = speakerMic;
    this.blindRange = blindRange;
    this.cfarScale = cfarScale;

    this.preGuard = Math.round(preGuardSec * sampleRate);
    // Bin 0 is the direct blast, which already corresponds to speakerMic/2 of
    // range, so the span has to account for that or the axis overshoots.
    this.profSamples = Math.ceil(
      (((2 * maxRange - speakerMic) / SPEED_OF_SOUND) * sampleRate)) + 1;
    this.tail = chirp.length + Math.round(tailSec * sampleRate);
    this.windowLength = this.preGuard + this.profSamples + this.tail;

    this.filterOpts = { sampleRate, mode: 'window', f0, f1 };
    this.filter = new MatchedFilter(
      chirp, nextPow2(this.windowLength + chirp.length), this.filterOpts);

    this.clutter = null;
    this.capturedReference = null;
  }

  /** Range in metres for a (possibly fractional) lag in samples from the direct blast. */
  binToRange(bin) {
    // The blast travels speakerMic directly; an echo travels out and back, so a
    // wall at R arrives (2R - speakerMic)/c after it.
    return (SPEED_OF_SOUND * (bin / this.sampleRate) + this.speakerMic) / 2;
  }

  get blindBins() {
    return Math.max(0, Math.ceil(
      (((2 * this.blindRange - this.speakerMic) / SPEED_OF_SOUND) * this.sampleRate)));
  }

  /**
   * Locate the direct blast inside a window, searching near where we expect it.
   * @returns {{idx: number, frac: number, val: number, noise: number}|null}
   */
  locateDirect(re, im, length, tolSec = 0.0015) {
    const env = magnitude(re, im, null, 0, length);
    const tol = Math.round(tolSec * this.sampleRate);
    const a = Math.max(1, this.preGuard - tol);
    const b = Math.min(length - 2, this.preGuard + tol);
    if (b <= a) return null;
    const idx = argMax(env, a, b);
    const pk = parabolicPeak(env, idx);
    return { idx, frac: pk.pos - idx, val: pk.val, noise: medianOf(env, 0, length), env };
  }

  /**
   * @param {Float32Array} rx window of recorded audio, windowLength long
   * @param {{cancel?: boolean, minDirectSnr?: number, minDirectLevel?: number}} opts
   * @returns {object|{error: string}} a range profile, or why there isn't one
   */
  analyze(rx, { cancel = true, minDirectSnr = 6, minDirectLevel = MIN_DIRECT_LEVEL } = {}) {
    const sr = this.sampleRate;
    const length = Math.min(rx.length, this.windowLength);

    let peakAbs = 0, sumSq = 0;
    for (let i = 0; i < length; i++) {
      const v = rx[i] < 0 ? -rx[i] : rx[i];
      if (v > peakAbs) peakAbs = v;
      sumSq += rx[i] * rx[i];
    }

    const { re, im } = this.filter.run(rx);
    const direct = this.locateDirect(re, im, length);
    if (!direct) return { error: 'window too short' };
    // An absolute floor as well as a relative one. In a silent room the noise
    // estimate collapses towards zero, and *any* ripple clears a purely
    // relative threshold — which is how a muted device ends up confidently
    // reporting a lock and then measuring nothing at all.
    if (direct.val < minDirectLevel) return { error: 'pulse too faint' };
    if (direct.val < minDirectSnr * direct.noise) return { error: 'no direct pulse' };

    const profLen = Math.min(this.profSamples, length - direct.idx);
    const pRe = new Float64Array(profLen);
    const pIm = new Float64Array(profLen);
    for (let i = 0; i < profLen; i++) {
      pRe[i] = re[direct.idx + i];
      pIm[i] = im[direct.idx + i];
    }

    let cancelled = false;
    if (cancel && this.clutter) {
      this._subtractClutter(pRe, pIm, profLen, direct);
      cancelled = true;
    }

    const strength = magnitude(pRe, pIm, null, 0, profLen);
    const blind = Math.min(this.blindBins, profLen - 1);
    const noise = medianOf(strength, blind, profLen);
    const threshold = cfarThreshold(strength, { guard: 8, train: 64, scale: this.cfarScale });
    const peaks = detectPeaks(strength, threshold, { start: blind, maxPeaks: 8, minSeparation: 6 });

    return {
      strength,
      threshold,
      noise,
      cancelled,
      directAmp: direct.val,
      directIndex: direct.idx,
      directFrac: direct.frac,
      inputLevel: Math.sqrt(sumSq / length),
      clipping: peakAbs > 0.985,
      blindBins: blind,
      minRange: this.binToRange(blind),
      maxRange: this.binToRange(profLen - 1),
      binToRange: (b) => this.binToRange(b),
      peaks: peaks.map((p) => ({
        range: this.binToRange(p.pos),
        bin: p.pos,
        strength: p.value,
        snrDb: toDb(p.value / Math.max(noise, 1e-12)),
      })),
    };
  }

  _subtractClutter(pRe, pIm, profLen, direct) {
    const c = this.clutter;
    // A template captured at a different max range may be shorter or longer
    // than the current profile. Subtracting over the overlap is correct either
    // way: the device's own signature is a near-field effect that has died out
    // long before the far end of the profile.
    const n = Math.min(profLen, c.re.length);
    const tRe = c.re.slice(0, n);
    const tIm = c.im.slice(0, n);

    // Align to this ping's sub-sample phase. Without this the residue of an
    // imperfectly cancelled blast sits right where the nearest walls show up.
    const d = direct.frac - c.frac;
    if (Math.abs(d) > 1e-4) phaseShift(tRe, tIm, -d, this.centreFreq, this.sampleRate);

    // Rescale to this ping's blast so a volume change doesn't leave a crater.
    const scale = c.directAmp > 0 ? direct.val / c.directAmp : 1;
    for (let i = 0; i < n; i++) {
      pRe[i] -= scale * tRe[i];
      pIm[i] -= scale * tIm[i];
    }
  }

  /**
   * Carry a calibration across a rebuild. Valid only when the transmit pulse is
   * unchanged, since both products are tied to the waveform they were measured
   * with.
   */
  adoptCalibration(prev) {
    if (!prev) return;
    if (prev.capturedReference) {
      this.filter.setReference(prev.capturedReference, this.filterOpts);
      this.capturedReference = prev.capturedReference;
    }
    if (prev.clutter) this.clutter = prev.clutter;
  }

  /**
   * Learn the device's own acoustic signature from windows recorded in open air.
   *
   * Two products, and the order matters:
   *
   *  1. A better filter reference. The recorded blast carries the speaker and
   *     mic response, so correlating against it compresses tighter than the
   *     mathematically ideal sweep.
   *  2. A clutter template: the blast plus the case ringing behind it, removed
   *     coherently so returns a metre out aren't riding its skirt.
   *
   * The template has to be built *after* the reference swap. One measured
   * through the old filter simply doesn't subtract from profiles made with the
   * new one.
   */
  calibrateFrom(windows) {
    const sr = this.sampleRate;
    if (!windows.length) throw new Error('No calibration pings captured');

    // Check for a rival speaker first, on the untouched windows.
    //
    // It has to happen here for two reasons. The averaged reference below is
    // cut relative to whichever blast was loudest, which clips the other one;
    // and once that reference is installed, the inverse filter partially
    // deconvolves the twin blast and hides the very thing we want to report.
    // (That deconvolution is real, and does steady the lock afterwards, but it
    // cannot touch the echo ghosts, whose spacing changes with bearing.)
    const secondaryPulse = this._detectSecondary(windows);

    // Pass 1 - stack the raw blasts, each cut at the same offset before its
    // own peak so they add coherently instead of smearing.
    const pre = Math.round(0.0005 * sr);
    const refLen = this.chirp.length + Math.round(0.004 * sr);
    const ref = new Float32Array(refLen);
    let used = 0;
    for (const w of windows) {
      const idx = this._quickDirect(w);
      if (idx == null) continue;
      const a = idx - pre;
      if (a < 0 || a + refLen > w.length) continue;
      for (let i = 0; i < refLen; i++) ref[i] += w[a + i];
      used++;
    }
    if (!used) throw new Error('Direct pulse too close to the window edge');
    for (let i = 0; i < refLen; i++) ref[i] /= used;

    this.filter.setReference(ref, this.filterOpts);
    this.capturedReference = ref;

    // Pass 2 - rebuild the clutter template through the new filter.
    const profLen = this.profSamples;
    const sRe = new Float64Array(profLen);
    const sIm = new Float64Array(profLen);
    let baseFrac = null, ampSum = 0, stacked = 0;

    for (const w of windows) {
      const len = Math.min(w.length, this.windowLength);
      const { re, im } = this.filter.run(w);
      const direct = this.locateDirect(re, im, len);
      if (!direct || direct.idx + profLen > len) continue;
      if (baseFrac === null) baseFrac = direct.frac;

      const cRe = new Float64Array(profLen);
      const cIm = new Float64Array(profLen);
      for (let i = 0; i < profLen; i++) { cRe[i] = re[direct.idx + i]; cIm[i] = im[direct.idx + i]; }

      const d = direct.frac - baseFrac;
      if (Math.abs(d) > 1e-4) phaseShift(cRe, cIm, -d, this.centreFreq, sr);
      for (let i = 0; i < profLen; i++) { sRe[i] += cRe[i]; sIm[i] += cIm[i]; }
      ampSum += direct.val;
      stacked++;
    }
    if (!stacked) throw new Error('Could not stack the calibration pings');
    for (let i = 0; i < profLen; i++) { sRe[i] /= stacked; sIm[i] /= stacked; }

    this.clutter = { re: sRe, im: sIm, frac: baseFrac ?? 0, directAmp: ampSum / stacked };
    return { pings: stacked, referenceLength: refLen, secondaryPulse };
  }

  /**
   * Look for a second direct pulse right behind the first one.
   *
   * An iPad with stereo speakers fires both unless told otherwise, and the two
   * are at different distances from the microphone. That shows up here as a
   * distinct compressed peak a few tens of samples after the main blast, and it
   * causes two separate problems:
   *
   *   - Every wall returns twice, split by half the speaker separation, and the
   *     split swings with bearing as the device turns.
   *   - Worse, the time origin snaps to whichever blast is momentarily louder.
   *     That is a function of frequency, orientation and whether a hand is over
   *     a speaker, so it can flip mid-session and bias every range at once.
   *
   * Calibration is the right place to check, because it runs in open air where
   * anything this close to the blast must belong to the device.
   *
   * @param {Float32Array} raw an averaged recording of the blast in open air
   * @returns {{lagSamples, pathMetres, rangeBias, ratio}|null}
   */
  /**
   * Run the secondary-pulse check over several pings and only believe a result
   * the majority agree on, so a single noise spike can't raise a false alarm.
   */
  _detectSecondary(windows, sample = 5) {
    const hits = [];
    const tried = Math.min(sample, windows.length);
    for (let i = 0; i < tried; i++) {
      const r = this.findSecondaryPulse(windows[i]);
      if (r) hits.push(r);
    }
    if (hits.length * 2 <= tried) return null; // not a majority

    hits.sort((a, b) => a.lagSamples - b.lagSamples);
    const median = hits[hits.length >> 1];
    // Require agreement on *where* it is, not just that something was there.
    const spread = hits[hits.length - 1].lagSamples - hits[0].lagSamples;
    return spread <= 4 ? median : null;
  }

  findSecondaryPulse(raw, { minRatio = 0.12, searchSec = 0.0015, skip = 8, tolSec = 0.0015 } = {}) {
    // Correlate against the ideal chirp, not the installed filter, so the
    // measurement is independent of whatever reference is currently loaded.
    const mf = new MatchedFilter(
      this.chirp, nextPow2(raw.length + this.chirp.length), this.filterOpts);
    const { re, im } = mf.run(raw);
    const env = magnitude(re, im, null, 0, raw.length);

    // Only look around where the direct blast is expected. In open air there
    // should be nothing else nearby, but a wall in view shouldn't get a vote.
    const tol = Math.round(tolSec * this.sampleRate);
    const span = Math.ceil(searchSec * this.sampleRate);
    const from = Math.max(1, this.preGuard - tol);
    const to = Math.min(env.length - 1, this.preGuard + tol + span);
    if (to <= from + skip) return null;

    const peak = env[argMax(env, from, to)];
    if (!(peak > 0)) return null;

    // Collect arrivals, then merge anything within a main-lobe width of its
    // neighbour so a single pulse's shoulders don't read as several.
    const clusters = [];
    for (let i = from; i < to; i++) {
      if (env[i] < env[i - 1] || env[i] < env[i + 1]) continue;
      if (env[i] < minRatio * peak) continue;
      const last = clusters[clusters.length - 1];
      if (last && i - last.index < skip) {
        if (env[i] > last.value) { last.index = i; last.value = env[i]; }
      } else {
        clusters.push({ index: i, value: env[i] });
      }
    }
    if (clusters.length < 2) return null;

    // The direct blast is the *earliest* arrival, not the loudest. With two
    // speakers of similar level the loudest is a coin toss, which is exactly
    // the instability being reported here.
    const first = clusters[0];
    let best = null;
    for (const c of clusters.slice(1)) {
      if (c.index - first.index > span) break;
      if (!best || c.value > best.value) best = c;
    }
    if (!best) return null;

    const pk = parabolicPeak(env, best.index);
    const firstPk = parabolicPeak(env, first.index);
    const path = ((pk.pos - firstPk.pos) / this.sampleRate) * SPEED_OF_SOUND;
    return {
      lagSamples: pk.pos - firstPk.pos,
      pathMetres: path,
      // If the lock flips between the two, every range shifts by this much.
      rangeBias: path / 2,
      ratio: best.value / first.value,
    };
  }

  clearCalibration() {
    this.clutter = null;
    this.capturedReference = null;
    this.filter.setReference(this.chirp, this.filterOpts);
  }

  _quickDirect(w) {
    const { re, im } = this.filter.run(w);
    const d = this.locateDirect(re, im, Math.min(w.length, this.windowLength));
    return d ? d.idx : null;
  }
}
