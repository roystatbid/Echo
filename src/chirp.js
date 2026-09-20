// Transmit waveform generation.
//
// We use a linear-FM sweep ("chirp") rather than a click. A click puts all its
// energy in one instant, so to be heard over the room it has to be loud enough
// to clip the mic. A chirp spreads the same energy over milliseconds and the
// matched filter squeezes it back into a single spike on receive. That buys
// roughly 10*log10(bandwidth * duration) dB of processing gain for free.
//
// Range resolution after compression is c / (2 * bandwidth), independent of how
// long the chirp is:  16 kHz of sweep -> about 1 cm.

export const SPEED_OF_SOUND = 343; // m/s at ~20 C, dry air

export const BANDS = {
  quiet:    { f0: 14000, f1: 21000, label: 'Quiet',    hint: 'Near-ultrasonic. Most adults barely hear it; kids and dogs will.' },
  balanced: { f0:  6000, f1: 20000, label: 'Balanced', hint: 'Audible chirp, good resolution and range. Best all-rounder.' },
  range:    { f0:  2000, f1: 18000, label: 'Long',     hint: 'Loudest and most annoying, but reaches furthest.' },
};

/**
 * Range resolution in metres for a given sweep bandwidth.
 * Two walls closer together than this merge into one blip.
 */
export function rangeResolution(bandwidthHz, c = SPEED_OF_SOUND) {
  return c / (2 * bandwidthHz);
}

/**
 * Build a Tukey-windowed linear sweep.
 *
 * The taper matters more than it looks: an abrupt start/stop smears the
 * compressed pulse into sidelobes that masquerade as phantom walls a few
 * centimetres away from every real one.
 */
export function makeChirp({ sampleRate, f0, f1, duration, taper = 0.3, amplitude = 1 }) {
  const n = Math.max(2, Math.round(duration * sampleRate));
  const x = new Float32Array(n);
  const k = (f1 - f0) / (n / sampleRate); // Hz per second

  const edge = Math.max(1, Math.floor((taper * n) / 2));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);

    let w = 1;
    if (i < edge) w = 0.5 * (1 - Math.cos((Math.PI * i) / edge));
    else if (i >= n - edge) w = 0.5 * (1 - Math.cos((Math.PI * (n - 1 - i)) / edge));

    x[i] = amplitude * w * Math.sin(phase);
  }
  return x;
}

/** Seconds of round trip for a target at `metres`, and the inverse. */
export const metresToSeconds = (m, c = SPEED_OF_SOUND) => (2 * m) / c;
export const secondsToMetres = (s, c = SPEED_OF_SOUND) => (s * c) / 2;
