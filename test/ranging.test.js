import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChirp, BANDS } from '../src/chirp.js';
import { PingAnalyzer } from '../src/ranging.js';
import { Room } from './room.js';

const SR = 48000;
const BAND = BANDS.balanced;

function build(opts = {}) {
  const chirp = makeChirp({ sampleRate: SR, f0: BAND.f0, f1: BAND.f1, duration: 0.005 });
  const analyzer = new PingAnalyzer({
    sampleRate: SR, chirp, f0: BAND.f0, f1: BAND.f1,
    maxRange: 6, speakerMic: 0.15, blindRange: 0.25, ...opts,
  });
  return { chirp, analyzer };
}

/** Capture calibration pings in "open air": the device signature, no walls. */
function calibrate(analyzer, room, n = 16) {
  const windows = [];
  for (let i = 0; i < n; i++) {
    windows.push(room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] }));
  }
  return analyzer.calibrateFrom(windows);
}

const nearest = (profile, target) =>
  profile.peaks.reduce((a, b) =>
    (Math.abs(a.range - target) < Math.abs(b.range - target) ? a : b), profile.peaks[0]);

test('finds a wall at a known distance through a realistic device response', () => {
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [2.4] });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard);

  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(!p.error, p.error);
  assert.ok(p.peaks.length >= 1, 'should see the wall');
  const hit = nearest(p, 2.4);
  assert.ok(Math.abs(hit.range - 2.4) < 0.02, `got ${hit.range.toFixed(3)} m`);
});

test('the direct blast lands where the time origin says it should', () => {
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [] });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard);
  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(!p.error, p.error);
  // Speaker colouration adds a little group delay; a millisecond of slack.
  assert.ok(Math.abs(p.directIndex - analyzer.preGuard) < 0.001 * SR,
    `direct at ${p.directIndex}, expected near ${analyzer.preGuard}`);
});

test('resolves several walls at once', () => {
  const { chirp, analyzer } = build();
  const walls = [1.1, 2.0, 3.6];
  const room = new Room({ sampleRate: SR, chirp, walls, ringAmp: 0.02 });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard);

  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(!p.error, p.error);
  for (const w of walls) {
    const hit = nearest(p, w);
    assert.ok(Math.abs(hit.range - w) < 0.03, `wall at ${w} m reported as ${hit?.range?.toFixed(3)}`);
  }
});

test('calibration flattens the near-field clutter pedestal', () => {
  // The case rings for a few milliseconds after every ping, sitting right on
  // top of the delays a wall half a metre away occupies. Subtracting the
  // device's own signature is what clears that ground.
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [], ringAmp: 0.12 });

  const empty = room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] });
  const raw = analyzer.analyze(empty, { cancel: false });
  assert.ok(!raw.error, raw.error);

  calibrate(analyzer, room, 24);
  const cleaned = analyzer.analyze(empty, { cancel: true });
  assert.ok(cleaned.cancelled, 'clutter template should have been applied');

  // Measure the leftover pedestal at short range, where the ringing lives.
  const at = (prof, m) => prof.strength[Math.round(analyzer.sampleRate * (2 * m - 0.15) / 343)];
  for (const m of [0.3, 0.45, 0.6]) {
    const ratio = at(raw, m) / at(cleaned, m);
    assert.ok(ratio > 8,
      `clutter at ${m} m only fell by ${ratio.toFixed(1)}x (want >8x)`);
  }
});

test('a close wall survives the cancellation that removes the ringdown', () => {
  const { chirp, analyzer } = build();
  const close = 0.45;
  const room = new Room({ sampleRate: SR, chirp, walls: [close], ringAmp: 0.12 });
  calibrate(analyzer, room, 24);

  const after = analyzer.analyze(
    room.record(analyzer.windowLength, analyzer.preGuard), { cancel: true });
  assert.ok(!after.error, after.error);

  const hit = after.peaks.find((p) => Math.abs(p.range - close) < 0.05);
  assert.ok(hit, `wall at ${close} m lost; peaks: ${JSON.stringify(after.peaks.map(p => +p.range.toFixed(2)))}`);
  // It should be comfortably the strongest thing in the profile.
  assert.equal(after.peaks[0].range.toFixed(2), hit.range.toFixed(2));
});

test('an empty room stays empty, at a bounded false-alarm rate', () => {
  // CFAR is a statistical detector, so the honest test is a rate over many
  // pings rather than a single clean profile. At the default threshold this
  // should be well under one blip per ping, and none of them strong.
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [], ringAmp: 0.12, seed: 99 });
  calibrate(analyzer, room, 24);

  let alarms = 0, strongest = 0;
  const pings = 120;
  for (let i = 0; i < pings; i++) {
    const p = analyzer.analyze(
      room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] }), { cancel: true });
    assert.ok(!p.error, p.error);
    alarms += p.peaks.length;
    for (const q of p.peaks) strongest = Math.max(strongest, q.snrDb);
  }
  const rate = alarms / pings;
  assert.ok(rate < 0.5, `${rate.toFixed(2)} false alarms per ping is too many`);
  assert.ok(strongest < 20, `a phantom reached ${strongest.toFixed(1)} dB SNR`);
});

test('cancellation survives a change in output level', () => {
  // Calibrate loud, then ping quiet. The template is rescaled to the measured
  // blast, so it should still subtract rather than leaving a crater.
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [], ringAmp: 0.12 });
  calibrate(analyzer, room);

  const rx = room.record(analyzer.windowLength, analyzer.preGuard, { walls: [1.7], gain: 0.55 });
  const p = analyzer.analyze(rx, { cancel: true });
  assert.ok(!p.error, p.error);
  const hit = nearest(p, 1.7);
  assert.ok(hit && Math.abs(hit.range - 1.7) < 0.03, `got ${hit?.range?.toFixed(3)} m`);
});

test('calibration keeps the range scale honest', () => {
  // Swapping the filter reference for the recorded blast must not shift the
  // time origin, or every distance would be biased.
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [3.0] });
  calibrate(analyzer, room);
  const rx = room.record(analyzer.windowLength, analyzer.preGuard);
  const p = analyzer.analyze(rx, { cancel: true });
  assert.ok(!p.error, p.error);
  const hit = nearest(p, 3.0);
  assert.ok(Math.abs(hit.range - 3.0) < 0.02, `got ${hit.range.toFixed(3)} m`);
});

test('reports a refusal when the speaker is silent', () => {
  // Room noise with no ping in it. Which refusal it is depends on how loud the
  // room is; what matters is that it never returns a measurement.
  const { analyzer } = build();
  const rx = new Float32Array(analyzer.windowLength);
  for (let i = 0; i < rx.length; i++) rx[i] = 0.001 * (Math.random() * 2 - 1);
  const p = analyzer.analyze(rx);
  assert.ok(['pulse too faint', 'no direct pulse'].includes(p.error),
    `unexpected result: ${JSON.stringify(p.error ?? p.peaks)}`);
});

test('flags a clipping input', () => {
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [2] });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard, { gain: 3 });
  for (let i = 0; i < rx.length; i++) rx[i] = Math.max(-1, Math.min(1, rx[i]));
  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(p.clipping, 'should notice the input is railed');
});

test('blind zone keeps the direct blast out of the peak list', () => {
  const { chirp, analyzer } = build({ blindRange: 0.4 });
  const room = new Room({ sampleRate: SR, chirp, walls: [2.2], ringAmp: 0.12 });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard);
  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(!p.error, p.error);
  assert.ok(p.peaks.every((q) => q.range >= 0.4 - 1e-9),
    `something reported inside the blind zone: ${JSON.stringify(p.peaks.map(q => +q.range.toFixed(2)))}`);
});

test('range axis covers exactly what was asked for', () => {
  const { analyzer } = build({ maxRange: 4 });
  assert.ok(Math.abs(analyzer.maxRange - 4) < 1e-9);
  // Bin 0 is the direct blast, which is already speakerMic/2 of "range"; the
  // last bin must still land on the requested maximum.
  assert.ok(Math.abs(analyzer.binToRange(0) - 0.075) < 1e-6, 'bin 0 is the direct path');
  const last = analyzer.binToRange(analyzer.profSamples - 1);
  assert.ok(last >= 4 && last - 4 < 0.01, `last bin is ${last.toFixed(3)} m, wanted 4`);
});

test('a calibration survives a change of max range', () => {
  // Changing the range scale rebuilds the analyzer. Losing the clutter template
  // there would silently un-blind the near field without telling anyone.
  const { chirp, analyzer } = build({ maxRange: 6 });
  const room = new Room({ sampleRate: SR, chirp, walls: [], ringAmp: 0.12 });
  calibrate(analyzer, room, 24);

  const wider = new PingAnalyzer({
    sampleRate: SR, chirp, f0: BAND.f0, f1: BAND.f1,
    maxRange: 9, speakerMic: 0.15, blindRange: 0.25,
  });
  wider.adoptCalibration(analyzer);
  assert.ok(wider.clutter, 'template should carry over');
  assert.ok(wider.capturedReference, 'reference should carry over');

  // The template is now shorter than the profile; it must still subtract over
  // the near field, which is the only place clutter lives.
  const empty = room.record(wider.windowLength, wider.preGuard, { walls: [] });
  const raw = analyzer.analyze(
    room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] }), { cancel: false });
  const cleaned = wider.analyze(empty, { cancel: true });
  assert.ok(cleaned.cancelled, 'should still be cancelling');

  const at = (prof, m) => prof.strength[Math.round(SR * (2 * m - 0.15) / 343)];
  assert.ok(at(raw, 0.4) / at(cleaned, 0.4) > 8, 'near-field clutter should still be removed');
});

test('a wall is still measured correctly after the range scale changes', () => {
  const { chirp, analyzer } = build({ maxRange: 6 });
  const room = new Room({ sampleRate: SR, chirp, walls: [2.2], ringAmp: 0.12 });
  calibrate(analyzer, room, 24);

  const wider = new PingAnalyzer({
    sampleRate: SR, chirp, f0: BAND.f0, f1: BAND.f1,
    maxRange: 9, speakerMic: 0.15, blindRange: 0.25,
  });
  wider.adoptCalibration(analyzer);

  const p = wider.analyze(room.record(wider.windowLength, wider.preGuard), { cancel: true });
  assert.ok(!p.error, p.error);
  const hit = nearest(p, 2.2);
  assert.ok(Math.abs(hit.range - 2.2) < 0.03, `got ${hit.range.toFixed(3)} m`);
});

test('a silent input is refused rather than locked onto', () => {
  // The relative SNR test alone is not enough: with no signal the noise
  // estimate collapses towards zero and any ripple clears it. A muted device
  // must say so, not report a confident measurement of nothing.
  const { analyzer } = build();
  const rx = new Float32Array(analyzer.windowLength); // digital silence
  assert.equal(analyzer.analyze(rx).error, 'pulse too faint');
});

test('a near-silent input is refused too', () => {
  const { analyzer } = build();
  const rx = new Float32Array(analyzer.windowLength);
  for (let i = 0; i < rx.length; i++) rx[i] = 1e-6 * (Math.random() * 2 - 1);
  const p = analyzer.analyze(rx);
  assert.ok(p.error, `expected a refusal, got peaks: ${JSON.stringify(p.peaks?.map(q => +q.range.toFixed(2)))}`);
});

test('a genuinely quiet but real ping is still accepted', () => {
  // The floor must not be so high that it rejects a usable signal from a
  // device held at low volume.
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [2.0], noise: 0.00002 });
  const rx = room.record(analyzer.windowLength, analyzer.preGuard, { gain: 0.02 });
  const p = analyzer.analyze(rx, { cancel: false });
  assert.ok(!p.error, `rejected a real ping: ${p.error}`);
  const hit = nearest(p, 2.0);
  assert.ok(Math.abs(hit.range - 2.0) < 0.03, `got ${hit.range.toFixed(3)} m`);
});
