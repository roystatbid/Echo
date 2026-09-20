import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT, nextPow2 } from '../src/fft.js';
import { makeChirp, rangeResolution, SPEED_OF_SOUND, secondsToMetres } from '../src/chirp.js';
import {
  MatchedFilter, magnitude, parabolicPeak, argMax,
  cfarThreshold, detectPeaks, medianOf,
} from '../src/dsp.js';

const SR = 48000;

function naiveDft(re, im) {
  const n = re.length;
  const oR = new Float64Array(n), oI = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    oR[k] = sr; oI[k] = si;
  }
  return { re: oR, im: oI };
}

test('FFT matches a naive DFT', () => {
  const n = 64;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.1); im[i] = 0; }
  const want = naiveDft(re, im);
  const f = new FFT(n);
  f.transform(re, im);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(re[k] - want.re[k]) < 1e-9, `re[${k}]`);
    assert.ok(Math.abs(im[k] - want.im[k]) < 1e-9, `im[${k}]`);
  }
});

test('FFT round-trips through its inverse', () => {
  const n = 256;
  const re = new Float64Array(n), im = new Float64Array(n);
  const orig = [];
  for (let i = 0; i < n; i++) { re[i] = Math.random() * 2 - 1; orig.push(re[i]); }
  const f = new FFT(n);
  f.transform(re, im);
  f.inverse(re, im);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('chirp sweeps the requested band and is tapered at the edges', () => {
  const x = makeChirp({ sampleRate: SR, f0: 2000, f1: 18000, duration: 0.005 });
  assert.equal(x.length, 240);
  assert.ok(Math.abs(x[0]) < 1e-6, 'starts at ~0');
  assert.ok(Math.abs(x[x.length - 1]) < 1e-3, 'ends at ~0');

  // Zero-crossing rate should climb from the start of the sweep to the end.
  const crossings = (a, b) => {
    let c = 0;
    for (let i = a + 1; i < b; i++) if (Math.sign(x[i]) !== Math.sign(x[i - 1])) c++;
    return c;
  };
  const early = crossings(20, 100);
  const late = crossings(140, 220);
  assert.ok(late > early * 1.5, `expected rising frequency, got ${early} then ${late}`);
});

// --- the real test: can we recover a known wall distance? ---

/** Build a fake recording: direct blast at `directM` path length + echoes. */
function synthesise({ chirp, directDelay, echoes, noise = 0, length }) {
  const rx = new Float32Array(length);
  const add = (delaySamples, amp) => {
    const i0 = Math.round(delaySamples);
    for (let i = 0; i < chirp.length; i++) {
      const j = i0 + i;
      if (j >= 0 && j < length) rx[j] += amp * chirp[i];
    }
  };
  add(directDelay, 1.0);
  for (const e of echoes) add(directDelay + e.delaySamples, e.amp);
  if (noise > 0) for (let i = 0; i < length; i++) rx[i] += noise * (Math.random() * 2 - 1);
  return rx;
}

/**
 * Mirrors the ranging maths in sonar.js: find the direct blast, then read
 * echo distance from the lag relative to it.
 */
function rangeOfEchoes(rx, chirp, { speakerMic = 0.15, blindM = 0.2, maxM = 6, band = { f0: 2000, f1: 18000 } } = {}) {
  const mf = new MatchedFilter(chirp, nextPow2(rx.length + chirp.length),
    { sampleRate: SR, mode: 'window', f0: band.f0, f1: band.f1 });
  const { re, im } = mf.run(rx);
  const env = magnitude(re, im, null, 0, rx.length);

  const direct = argMax(env, 0, env.length);
  const directPos = parabolicPeak(env, direct).pos;

  const profStart = direct;
  const profLen = Math.min(env.length - profStart, Math.ceil(((2 * maxM) / SPEED_OF_SOUND) * SR));
  const prof = env.slice(profStart, profStart + profLen);

  const th = cfarThreshold(prof, { guard: 8, train: 64, scale: 3.5 });
  const blindSamples = Math.ceil((((2 * blindM - speakerMic) / SPEED_OF_SOUND) * SR));
  const peaks = detectPeaks(prof, th, { start: blindSamples, maxPeaks: 6 });

  return peaks.map((p) => {
    const lag = (profStart + p.pos) - directPos;
    const metres = (SPEED_OF_SOUND * (lag / SR) + speakerMic) / 2;
    return { metres, value: p.value };
  });
}

test('recovers a single wall distance to within a centimetre', () => {
  const chirp = makeChirp({ sampleRate: SR, f0: 2000, f1: 18000, duration: 0.005 });
  const speakerMic = 0.15;
  const trueRange = 2.35;
  // Echo arrives (2R - speakerMic)/c after the direct blast.
  const echoDelay = (((2 * trueRange - speakerMic) / SPEED_OF_SOUND) * SR);

  const rx = synthesise({
    chirp,
    directDelay: 1000,
    echoes: [{ delaySamples: echoDelay, amp: 0.05 }],
    noise: 0.002,
    length: 8192,
  });

  const found = rangeOfEchoes(rx, chirp, { speakerMic });
  assert.ok(found.length >= 1, 'should detect at least one echo');
  const best = found[0];
  assert.ok(Math.abs(best.metres - trueRange) < 0.01,
    `expected ~${trueRange} m, got ${best.metres.toFixed(3)} m`);
});

test('separates two walls a resolution cell apart', () => {
  const f0 = 2000, f1 = 18000;
  const chirp = makeChirp({ sampleRate: SR, f0, f1, duration: 0.005 });
  const res = rangeResolution(f1 - f0);
  assert.ok(res < 0.02, `expected ~1 cm resolution, got ${res}`);

  const speakerMic = 0.15;
  const r1 = 1.8, r2 = 1.8 + res * 6; // comfortably resolvable
  const d = (r) => (((2 * r - speakerMic) / SPEED_OF_SOUND) * SR);

  const rx = synthesise({
    chirp,
    directDelay: 800,
    echoes: [{ delaySamples: d(r1), amp: 0.06 }, { delaySamples: d(r2), amp: 0.05 }],
    noise: 0.001,
    length: 8192,
  });

  const found = rangeOfEchoes(rx, chirp, { speakerMic });
  assert.ok(found.length >= 2, `expected 2 echoes, got ${found.length}`);
  // rangeOfEchoes returns strongest-first; the two real walls should dominate.
  const walls = found.slice(0, 2).sort((a, b) => a.metres - b.metres);
  assert.ok(Math.abs(walls[0].metres - r1) < 0.02, `first wall: ${walls[0].metres}`);
  assert.ok(Math.abs(walls[1].metres - r2) < 0.02, `second wall: ${walls[1].metres}`);
  // and they should stand well clear of whatever came third
  if (found.length > 2) {
    assert.ok(found[2].value < 0.4 * found[1].value,
      `third return too strong (${found[2].value} vs ${found[1].value})`);
  }
});

test('range estimate stays accurate across the working envelope', () => {
  const chirp = makeChirp({ sampleRate: SR, f0: 6000, f1: 20000, duration: 0.006 });
  const speakerMic = 0.15;
  for (const trueRange of [0.4, 0.75, 1.2, 2.0, 3.3, 4.8]) {
    const rx = synthesise({
      chirp,
      directDelay: 600,
      echoes: [{ delaySamples: (((2 * trueRange - speakerMic) / SPEED_OF_SOUND) * SR), amp: 0.04 }],
      noise: 0.0015,
      length: 8192,
    });
    const found = rangeOfEchoes(rx, chirp, { speakerMic, blindM: 0.25, band: { f0: 6000, f1: 20000 } });
    assert.ok(found.length >= 1, `no echo found at ${trueRange} m`);
    const nearest = found.reduce((a, b) => (Math.abs(a.metres - trueRange) < Math.abs(b.metres - trueRange) ? a : b));
    assert.ok(Math.abs(nearest.metres - trueRange) < 0.015,
      `at ${trueRange} m got ${nearest.metres.toFixed(3)} m`);
  }
});

test('windowed filter keeps near-in sidelobes below -35 dB', () => {
  // Sidelobes are what turn one real wall into a cluster of phantom ones.
  const f0 = 2000, f1 = 18000;
  const chirp = makeChirp({ sampleRate: SR, f0, f1, duration: 0.005 });
  const L = 8192;
  const rx = new Float32Array(L);
  for (let i = 0; i < chirp.length; i++) rx[1000 + i] = chirp[i];

  const mf = new MatchedFilter(chirp, nextPow2(L + chirp.length),
    { sampleRate: SR, mode: 'window', f0, f1 });
  const { re, im } = mf.run(rx);
  const env = magnitude(re, im, null, 0, L);

  const pk = argMax(env);
  const pv = env[pk];
  let worst = 0, worstAt = 0;
  for (let i = 0; i < L; i++) {
    if (Math.abs(i - pk) < 6) continue; // main lobe is ~2 cm wide
    if (env[i] > worst) { worst = env[i]; worstAt = i - pk; }
  }
  const db = 20 * Math.log10(worst / pv);
  assert.ok(db < -35, `worst sidelobe ${db.toFixed(1)} dB at lag ${worstAt}`);
});

test('peak amplitude reads as a fraction of the direct blast', () => {
  // The filter is normalised so a return of amplitude a peaks at a. That makes
  // the display gain meaningful instead of arbitrary.
  const f0 = 2000, f1 = 18000;
  const chirp = makeChirp({ sampleRate: SR, f0, f1, duration: 0.005 });
  const L = 8192;
  const mf = new MatchedFilter(chirp, nextPow2(L + chirp.length),
    { sampleRate: SR, mode: 'window', f0, f1 });

  for (const amp of [1, 0.3, 0.05]) {
    const rx = new Float32Array(L);
    for (let i = 0; i < chirp.length; i++) rx[1000 + i] = amp * chirp[i];
    const { re, im } = mf.run(rx);
    const env = magnitude(re, im, null, 0, L);
    const pv = env[argMax(env)];
    assert.ok(Math.abs(pv - amp) < 0.02 * Math.max(amp, 0.1),
      `amplitude ${amp} compressed to ${pv.toFixed(4)}`);
  }
});

test('CFAR rejects pure noise', () => {
  const n = 2000;
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.abs(Math.random());
  const th = cfarThreshold(env, { guard: 8, train: 64, scale: 5 });
  const peaks = detectPeaks(env, th, { start: 100, maxPeaks: 20 });
  assert.ok(peaks.length <= 2, `expected almost no false alarms, got ${peaks.length}`);
});

test('parabolic interpolation beats integer sample resolution', () => {
  // Sample a smooth peak deliberately placed between two samples.
  const y = new Float64Array(9);
  const centre = 4.3;
  for (let i = 0; i < 9; i++) y[i] = Math.exp(-((i - centre) ** 2) / 2);
  const { pos } = parabolicPeak(y, argMax(y));
  assert.ok(Math.abs(pos - centre) < 0.05, `got ${pos}`);
});

test('median gives a stable noise floor despite strong returns', () => {
  const env = new Float64Array(1000).fill(1);
  for (let i = 100; i < 110; i++) env[i] = 500;
  assert.equal(medianOf(env), 1);
});

test('secondsToMetres round trip', () => {
  assert.ok(Math.abs(secondsToMetres((2 * 3) / SPEED_OF_SOUND) - 3) < 1e-9);
});
