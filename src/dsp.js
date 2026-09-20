import { FFT, nextPow2 } from './fft.js';

/**
 * Matched filter (pulse compression) producing a complex analytic output.
 *
 * Everything happens in one trip through the frequency domain:
 *   S = FFT(rx) * conj(FFT(ref))      <- cross-correlation
 *   then zero the negative frequencies and double the positive ones,
 *   which turns the real correlation into its analytic signal.
 *
 * Keeping the result complex (rather than jumping straight to magnitude) is
 * what lets us coherently cancel the direct blast later: the speaker's ringing
 * has a stable phase from ping to ping, so it subtracts properly. Magnitudes
 * would only ever subtract approximately.
 */
export class MatchedFilter {
  /**
   * @param {Float32Array|Float64Array} reference transmitted waveform
   * @param {number} fftSize power of two, >= rx length + reference length
   * @param {object} opts see setReference
   */
  constructor(reference, fftSize, opts = {}) {
    const n = fftSize ?? nextPow2(reference.length * 4);
    this.n = n;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.opts = { sampleRate: 48000, regularization: 0.01, mode: 'window', ...opts };
    this.setReference(reference, this.opts);
  }

  /**
   * Install a reference waveform and build the receive filter from it.
   *
   * Two modes:
   *
   *  'matched' — the textbook H = conj(REF). Maximises SNR, but a linear sweep
   *    compresses to a sinc-like pulse whose first sidelobes sit only ~13 dB
   *    down. On a display those read as phantom walls a couple of centimetres
   *    either side of every real one.
   *
   *  'window' (default) — a mismatched filter, H = conj(REF) * W / (|REF|^2 + eps).
   *    Dividing by the reference's own power spectrum flattens the response,
   *    then W (a Hamming taper across the sweep band) shapes it deliberately,
   *    putting sidelobes down around -40 dB. Costs a fraction of a dB of SNR
   *    and widens the main lobe slightly. Well worth it.
   *
   *    The division does something else valuable: it equalises whatever the
   *    speaker and mic did to the chirp. That matters once we replace the
   *    reference with the *recorded* direct blast after calibration, since that
   *    version carries the full, lumpy hardware response.
   *
   * eps regularises the division so quiet, noise-dominated bins outside the
   * sweep don't get amplified into garbage.
   */
  setReference(ref, opts = {}) {
    const { sampleRate, regularization, mode, f0 = 0, f1 = Infinity } = { ...this.opts, ...opts };
    const n = this.n;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const m = Math.min(ref.length, n);
    for (let i = 0; i < m; i++) re[i] = ref[i];
    this.fft.transform(re, im);

    const half = n >> 1;
    const binHz = sampleRate / n;
    const hasBand = isFinite(f1) && f1 > f0;

    // Shape the compressed pulse: Hamming across the occupied band, zero outside.
    const W = new Float64Array(half + 1);
    let bandPower = 0, bandBins = 0;
    for (let k = 0; k <= half; k++) {
      const f = k * binHz;
      const inBand = hasBand ? (f >= f0 && f <= f1) : true;
      if (!inBand) continue;
      W[k] = hasBand
        ? 0.54 - 0.46 * Math.cos((2 * Math.PI * (f - f0)) / (f1 - f0))
        : 1;
      bandPower += re[k] * re[k] + im[k] * im[k];
      bandBins++;
    }
    const eps = regularization * (bandBins ? bandPower / bandBins : 1);

    // Store REF * g; run() conjugates it on the fly.
    let norm = 0;
    for (let k = 0; k <= half; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const g = mode === 'window' ? W[k] / (p + eps) : 1;
      re[k] *= g;
      im[k] *= g;
      const aw = (k > 0 && k < half) ? 2 : 1;
      norm += aw * p * g;
    }
    for (let k = half + 1; k < n; k++) { re[k] = 0; im[k] = 0; }

    this.refRe = re;
    this.refIm = im;
    this.refLen = m;
    this.mode = mode;
    // Scale so that filtering the reference itself yields a peak of 1.0.
    // Echo amplitudes then read directly as a fraction of the direct blast.
    this.refScale = norm !== 0 ? n / norm : 1;
  }

  /**
   * Correlate `rx` against the reference.
   * @returns {{re: Float64Array, im: Float64Array}} reused internal buffers.
   *   Index k is a lag of k samples from the start of `rx`.
   */
  run(rx) {
    const n = this.n, re = this.re, im = this.im;
    re.fill(0);
    im.fill(0);
    const m = Math.min(rx.length, n);
    for (let i = 0; i < m; i++) re[i] = rx[i];
    this.fft.transform(re, im);

    const half = n >> 1;
    const s = this.refScale;
    for (let k = 0; k < n; k++) {
      if (k > half) { re[k] = 0; im[k] = 0; continue; }
      const ar = re[k], ai = im[k];
      const br = this.refRe[k], bi = this.refIm[k];
      // (a) * conj(b), then the analytic-signal weighting
      const sr = ar * br + ai * bi;
      const si = ai * br - ar * bi;
      const g = (k > 0 && k < half) ? 2 * s : s;
      re[k] = sr * g;
      im[k] = si * g;
    }
    this.fft.inverse(re, im);
    return { re, im };
  }
}

/** Magnitude of a complex buffer into `out`. */
export function magnitude(re, im, out, offset = 0, length = re.length) {
  const dst = out ?? new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const r = re[offset + i], m = im[offset + i];
    dst[i] = Math.sqrt(r * r + m * m);
  }
  return dst;
}

/**
 * Sub-sample peak location by fitting a parabola through the peak and its
 * neighbours. At 48 kHz one sample is 3.6 mm of range, so this is the
 * difference between "about 2 metres" and "2.03 metres".
 */
export function parabolicPeak(y, i) {
  if (i <= 0 || i >= y.length - 1) return { pos: i, val: y[i] };
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return { pos: i, val: b };
  const off = (0.5 * (a - c)) / denom;
  return { pos: i + off, val: b - 0.25 * (a - c) * off };
}

/** Index of the largest sample in [start, end). */
export function argMax(y, start = 0, end = y.length) {
  let bi = start, bv = -Infinity;
  for (let i = start; i < end; i++) {
    if (y[i] > bv) { bv = y[i]; bi = i; }
  }
  return bi;
}

/**
 * Smallest-of cell-averaging CFAR.
 *
 * Plain averaging CFAR breaks down right after the direct blast, where the
 * leading window is still full of speaker ringdown and inflates the threshold
 * enough to hide a genuine nearby wall. Taking the *smaller* of the two
 * one-sided estimates keeps the threshold sane across that clutter edge.
 */
export function cfarThreshold(env, { guard = 6, train = 40, scale = 4 } = {}) {
  const n = env.length;
  const th = new Float64Array(n);

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const sum = (a, b) => prefix[Math.min(n, Math.max(0, b))] - prefix[Math.min(n, Math.max(0, a))];
  const count = (a, b) => Math.min(n, Math.max(0, b)) - Math.min(n, Math.max(0, a));

  for (let i = 0; i < n; i++) {
    const lA = i - guard - train, lB = i - guard;
    const tA = i + guard + 1, tB = i + guard + 1 + train;
    const lc = count(lA, lB), tc = count(tA, tB);
    const lead = lc > 0 ? sum(lA, lB) / lc : Infinity;
    const trail = tc > 0 ? sum(tA, tB) / tc : Infinity;
    let noise = Math.min(lead, trail);
    if (!isFinite(noise)) noise = lc > 0 ? lead : (tc > 0 ? trail : 0);
    th[i] = scale * noise;
  }
  return th;
}

/** Robust noise floor: the median is immune to the handful of strong returns. */
export function medianOf(env, start = 0, end = env.length) {
  const slice = Array.prototype.slice.call(env, start, end).sort((a, b) => a - b);
  if (!slice.length) return 0;
  return slice[slice.length >> 1];
}

/**
 * Local maxima that clear the CFAR threshold, strongest first.
 */
export function detectPeaks(env, threshold, { start = 1, end = env.length - 1, maxPeaks = 8, minSeparation = 4 } = {}) {
  const found = [];
  for (let i = Math.max(1, start); i < Math.min(env.length - 1, end); i++) {
    const v = env[i];
    if (v <= threshold[i]) continue;
    if (v < env[i - 1] || v < env[i + 1]) continue;
    const { pos, val } = parabolicPeak(env, i);
    found.push({ index: i, pos, value: val });
  }
  found.sort((a, b) => b.value - a.value);

  const kept = [];
  for (const p of found) {
    if (kept.length >= maxPeaks) break;
    if (kept.some((q) => Math.abs(q.pos - p.pos) < minSeparation)) continue;
    kept.push(p);
  }
  return kept;
}

/**
 * Rotate a complex buffer by a fractional-sample delay, using the narrowband
 * approximation (a pure phase twist at the chirp's centre frequency).
 *
 * The direct blast lands on a slightly different sub-sample phase from ping to
 * ping. Without this correction the coherent canceller leaves a residue right
 * where we most want a clean view.
 */
export function phaseShift(re, im, fracSamples, centreFreq, sampleRate) {
  const ang = (-2 * Math.PI * centreFreq * fracSamples) / sampleRate;
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < re.length; i++) {
    const r = re[i], m = im[i];
    re[i] = r * c - m * s;
    im[i] = r * s + m * c;
  }
}

/** Convert a linear ratio to dB, floored so log(0) can't poison the display. */
export function toDb(v, floor = 1e-12) {
  return 20 * Math.log10(Math.max(v, floor));
}
