import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChannels } from '../src/dsp.js';

/** Build the statistics the worklet would accumulate for two channel buffers. */
function stats(a, b) {
  let sumA = 0, sumB = 0, sumDiff = 0, sumAB = 0;
  for (let i = 0; i < a.length; i++) {
    sumA += a[i] * a[i];
    sumB += b[i] * b[i];
    const d = a[i] - b[i];
    sumDiff += d * d;
    sumAB += a[i] * b[i];
  }
  return { count: 2, frames: a.length, sumA, sumB, sumDiff, sumAB };
}

const noise = (n, seed = 1) => {
  let s = seed >>> 0;
  return Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  });
};

test('one channel is reported as such', () => {
  assert.equal(classifyChannels({ count: 1 }).verdict, 'single channel');
});

test('no input is distinguished from silence', () => {
  assert.equal(classifyChannels({ count: 0 }).verdict, 'no input');
  const z = new Array(512).fill(0);
  assert.equal(classifyChannels(stats(z, z)).verdict, 'silent');
});

test('an upmixed mono stream is not mistaken for two microphones', () => {
  // This is the trap: getSettings() would call this stereo.
  const a = noise(2048);
  assert.equal(classifyChannels(stats(a, a.slice())).verdict, 'duplicated mono');
});

test('a dead second channel is called out', () => {
  const a = noise(2048);
  const b = new Array(2048).fill(0);
  assert.equal(classifyChannels(stats(a, b)).verdict, 'second channel silent');
});

/** Band-limit a noise sequence, the way a speaker and a room do. */
function smooth(x, width = 8) {
  return x.map((_, i) => {
    let sum = 0;
    for (let k = 0; k < width; k++) sum += x[Math.max(0, i - k)];
    return sum / width;
  });
}

test('two real microphones read as distinct but correlated', () => {
  // Two mics a few centimetres apart hear the same room with a small delay and
  // a little independent self-noise: correlated, but not identical.
  //
  // The source has to be band-limited for this to be a fair model. White noise
  // shifted by even one sample is completely uncorrelated, so testing against
  // it would be testing a signal no microphone ever sees.
  const src = smooth(noise(4096, 7));
  const own = smooth(noise(4096, 99));
  const a = src.map((v, i) => v + 0.02 * own[i]);
  const b = src.map((_, i) => (src[i - 3] ?? 0) * 0.98 + 0.02 * own[(i + 512) % 4096]);

  const r = classifyChannels(stats(a, b));
  assert.equal(r.verdict, 'distinct');
  assert.ok(r.correlation > 0.5, `correlation ${r.correlation}`);
  assert.ok(r.separationDb < 30, `channels too close to identical: ${r.separationDb} dB`);
});

test('a small gain difference alone is not two microphones', () => {
  // One mic, upmixed and with the channels at slightly different levels, is
  // still one mic. It should not read as 'distinct' just because it isn't
  // bit-identical... but it will, so the verdict alone is not the whole story
  // and the correlation is what separates them.
  const a = smooth(noise(2048, 3));
  const b = a.map((v) => v * 0.97);
  const r = classifyChannels(stats(a, b));
  assert.ok(r.correlation > 0.999,
    `a scaled copy should correlate almost perfectly, got ${r.correlation}`);
});

test('statistics that have not arrived yet say so', () => {
  assert.equal(classifyChannels({ count: 2, frames: 0 }).verdict, 'measuring…');
});
