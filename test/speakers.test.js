import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChirp, BANDS, SPEED_OF_SOUND } from '../src/chirp.js';
import { PingAnalyzer } from '../src/ranging.js';
import { Room } from './room.js';

const SR = 48000;
const BAND = BANDS.balanced;
// An iPad with landscape stereo: speakers at opposite ends, mic near one.
const SEPARATION = 0.22;
const DIRECT_EXTRA = 0.20;

function build(opts = {}) {
  const chirp = makeChirp({ sampleRate: SR, f0: BAND.f0, f1: BAND.f1, duration: 0.005 });
  return {
    chirp,
    analyzer: new PingAnalyzer({
      sampleRate: SR, chirp, f0: BAND.f0, f1: BAND.f1,
      maxRange: 6, speakerMic: 0.15, blindRange: 0.25, ...opts,
    }),
  };
}

const secondSpeaker = (echoExtra, gain = 1) =>
  [{ directExtra: DIRECT_EXTRA, echoExtra, gain }];

test('one speaker gives one return per wall', () => {
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [2.4], ringAmp: 0.02, seed: 3 });
  const p = analyzer.analyze(room.record(analyzer.windowLength, analyzer.preGuard), { cancel: false });
  assert.ok(!p.error, p.error);
  const near = p.peaks.filter((q) => q.range > 1.8 && q.range < 3.2);
  assert.equal(near.length, 1, `expected one return, got ${JSON.stringify(near.map(q => +q.range.toFixed(2)))}`);
  assert.ok(Math.abs(near[0].range - 2.4) < 0.02);
});

test('two speakers split every wall into a pair', () => {
  const { chirp, analyzer } = build();
  const room = new Room({
    sampleRate: SR, chirp, walls: [2.4], ringAmp: 0.02, seed: 3,
    speakers: secondSpeaker(SEPARATION),
  });
  const p = analyzer.analyze(room.record(analyzer.windowLength, analyzer.preGuard), { cancel: false });
  const near = p.peaks.filter((q) => q.range > 1.8 && q.range < 3.2).sort((a, b) => a.range - b.range);
  assert.ok(near.length >= 2, 'the second speaker should produce a ghost');
  // The ghost sits half the extra path away, because range is half of path.
  assert.ok(Math.abs((near[1].range - near[0].range) - SEPARATION / 2) < 0.02,
    `split was ${((near[1].range - near[0].range) * 100).toFixed(1)} cm`);
});

test('the ghost moves with bearing, so it smears rather than offsetting', () => {
  // A fixed offset could be calibrated out. This one cannot: it is the
  // projection of the speaker separation onto the bearing, so it collapses
  // when the wall is off to the side and is widest dead ahead.
  const { chirp } = build();
  const splitAt = (bearingDeg) => {
    const { analyzer } = build();
    const room = new Room({
      sampleRate: SR, chirp, walls: [2.4], ringAmp: 0.02, seed: 3,
      speakers: secondSpeaker(SEPARATION * Math.cos((bearingDeg * Math.PI) / 180)),
    });
    const p = analyzer.analyze(room.record(analyzer.windowLength, analyzer.preGuard), { cancel: false });
    const near = p.peaks.filter((q) => q.range > 1.8 && q.range < 3.2).map((q) => q.range).sort((a, b) => a - b);
    return near.length > 1 ? near[near.length - 1] - near[0] : 0;
  };
  const ahead = splitAt(0);
  const oblique = splitAt(60);
  assert.ok(ahead > 0.08, `expected a wide split ahead, got ${(ahead * 100).toFixed(1)} cm`);
  assert.ok(oblique < ahead * 0.75,
    `split should shrink off-axis: ${(ahead * 100).toFixed(1)} cm vs ${(oblique * 100).toFixed(1)} cm`);
});

test('the time origin latches to whichever blast is louder', () => {
  // This is the dangerous one: the flip biases every range in the profile at
  // once, and which speaker is louder depends on frequency and on whether a
  // hand is over one of them.
  const { chirp } = build();
  const rangeWith = (gain) => {
    const { analyzer } = build();
    const room = new Room({
      sampleRate: SR, chirp, walls: [2.4], ringAmp: 0.02, seed: 3,
      speakers: secondSpeaker(SEPARATION, gain),
    });
    const p = analyzer.analyze(room.record(analyzer.windowLength, analyzer.preGuard), { cancel: false });
    const near = p.peaks.filter((q) => q.range > 1.8 && q.range < 3.2).sort((a, b) => a.range - b.range)[0];
    return { origin: p.directIndex - analyzer.preGuard, range: near?.range };
  };

  const quiet = rangeWith(0.9);
  const loud = rangeWith(1.1);
  assert.equal(quiet.origin, 0, 'should lock to the near speaker while it dominates');
  assert.ok(loud.origin > 10, 'should have jumped to the far speaker');
  const bias = Math.abs(loud.range - quiet.range);
  assert.ok(Math.abs(bias - DIRECT_EXTRA / 2) < 0.02,
    `a flip should bias every range by half the extra path; saw ${(bias * 100).toFixed(1)} cm`);
});

test('calibration detects the second speaker', () => {
  const { chirp, analyzer } = build();
  const room = new Room({
    sampleRate: SR, chirp, walls: [], ringAmp: 0.08, seed: 11,
    speakers: secondSpeaker(SEPARATION),
  });
  const windows = [];
  for (let i = 0; i < 16; i++) {
    windows.push(room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] }));
  }
  const result = analyzer.calibrateFrom(windows);
  assert.ok(result.secondaryPulse, 'should have spotted the second blast');
  assert.ok(Math.abs(result.secondaryPulse.pathMetres - DIRECT_EXTRA) < 0.03,
    `reported ${result.secondaryPulse.pathMetres.toFixed(3)} m, expected ${DIRECT_EXTRA}`);
  assert.ok(Math.abs(result.secondaryPulse.rangeBias - DIRECT_EXTRA / 2) < 0.02);
});

test('calibration reports nothing extra for a single speaker', () => {
  const { chirp, analyzer } = build();
  const room = new Room({ sampleRate: SR, chirp, walls: [], ringAmp: 0.08, seed: 11 });
  const windows = [];
  for (let i = 0; i < 16; i++) {
    windows.push(room.record(analyzer.windowLength, analyzer.preGuard, { walls: [] }));
  }
  const result = analyzer.calibrateFrom(windows);
  assert.equal(result.secondaryPulse, null,
    `false alarm: ${JSON.stringify(result.secondaryPulse)}`);
});

test('a co-located pair is harmless, which is why the choice is a setting', () => {
  // Some iPads put both speakers on the same edge. There the extra path is
  // small enough to fall inside one resolution cell, and the only effect is
  // more transmit power.
  const { chirp, analyzer } = build();
  const room = new Room({
    sampleRate: SR, chirp, walls: [2.4], ringAmp: 0.02, seed: 3,
    speakers: [{ directExtra: 0.01, echoExtra: 0.01, gain: 1 }],
  });
  const p = analyzer.analyze(room.record(analyzer.windowLength, analyzer.preGuard), { cancel: false });
  const near = p.peaks.filter((q) => q.range > 1.8 && q.range < 3.2);
  assert.equal(near.length, 1, `expected a single merged return, got ${near.length}`);
  assert.ok(Math.abs(near[0].range - 2.4) < 0.02);
});
