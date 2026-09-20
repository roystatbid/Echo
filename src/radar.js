import { toDb } from './dsp.js';

/**
 * Plan-position display.
 *
 * Returns accumulate into a polar buffer indexed by [bearing][range] and decay
 * over time, which is what gives the classic phosphor-persistence look and,
 * more usefully, lets a slow turn build up a picture of the whole room from a
 * sensor that only ever measures one number at a time.
 *
 * The angular spread of each blip is honest about its origin: it is the
 * assumed width of the device's acoustic beam, not a measurement. A single
 * speaker and mic cannot tell you which direction an echo came from; all the
 * bearing information on screen comes from the iPad's own orientation.
 */

const SWEEP_TAU = 6; // seconds for a painted return to fade away

export class RadarDisplay {
  constructor(canvas, { angleBins = 360, rangeBins = 300 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.angleBins = angleBins;
    this.rangeBins = rangeBins;

    this.buf = new Float32Array(angleBins * rangeBins);
    this.painted = new Float32Array(angleBins); // coverage, for the "keep turning" hint

    // The polar picture is rendered small and scaled up. At full retina size a
    // per-pixel loop is the one thing that would actually drop frames.
    this.polar = document.createElement('canvas');
    this.polar.width = 512;
    this.polar.height = 512;
    this.polarCtx = this.polar.getContext('2d');
    this.image = this.polarCtx.createImageData(512, 512);
    this._buildLut();

    this.lastRender = performance.now();
    this.maxRange = 6;
    this.units = 'm';
  }

  /**
   * Pixel -> polar bin lookup, built once. Without it this is a couple of
   * hundred thousand atan2 calls per frame.
   */
  _buildLut() {
    const S = 512, half = S / 2;
    const lut = new Int32Array(S * S).fill(-1);
    const rad = half - 1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = x - half + 0.5;
        const dy = y - half + 0.5;
        const r = Math.hypot(dx, dy);
        if (r > rad) continue;
        // Screen up is straight ahead; bearing increases clockwise.
        let th = Math.atan2(dx, -dy);
        if (th < 0) th += 2 * Math.PI;
        const a = Math.min(this.angleBins - 1, Math.floor((th / (2 * Math.PI)) * this.angleBins));
        const rb = Math.min(this.rangeBins - 1, Math.floor((r / rad) * this.rangeBins));
        lut[y * S + x] = a * this.rangeBins + rb;
      }
    }
    this.lut = lut;
  }

  clear() {
    this.buf.fill(0);
    this.painted.fill(0);
  }

  /**
   * Fold one range profile into the display at the bearing it was taken from.
   *
   * @param {object} profile from PingAnalyzer.analyze
   * @param {number} bearing radians, 0 = straight ahead
   * @param {object} o display mapping
   */
  paint(profile, bearing, {
    beamWidth = 40 * Math.PI / 180, // full width of the assumed acoustic beam
    gateDb = 12,                     // raw SNR below this doesn't light up at all
    dynDb = 26,                      // SNR span mapped to full brightness
    tvg = 1.2,                       // spreading-loss compensation exponent
    maxRange = this.maxRange,
  } = {}) {
    const { strength, noise, blindBins } = profile;
    const n = strength.length;
    const floor = Math.max(noise, 1e-12);

    // Collapse the sample-rate profile onto display bins, keeping peaks.
    const line = this._line ?? (this._line = new Float32Array(this.rangeBins));
    line.fill(0);
    const lastBin = profile.binToRange(n - 1);
    for (let i = blindBins; i < n; i++) {
      const r = profile.binToRange(i);
      if (r > maxRange) break;
      const rb = Math.min(this.rangeBins - 1, Math.floor((r / maxRange) * this.rangeBins));
      const v = strength[i];
      if (v > line[rb]) line[rb] = v;
    }

    // Map to brightness.
    //
    // The gate is applied to *raw* SNR, before any range compensation. Doing it
    // the other way round lets time-varying gain lift the noise floor at long
    // range above the gate, and the whole outer dial glows green.
    const vis = this._vis ?? (this._vis = new Float32Array(this.rangeBins));
    for (let rb = 0; rb < this.rangeBins; rb++) {
      const v = line[rb];
      if (v <= 0) { vis[rb] = 0; continue; }
      const snr = toDb(v / floor);
      if (snr < gateDb) { vis[rb] = 0; continue; }
      // Only now compensate spreading loss, so two walls of equal reflectivity
      // read equally bright at different distances.
      const r = Math.max(1, ((rb + 0.5) / this.rangeBins) * maxRange);
      const db = snr + tvg * 20 * Math.log10(r);
      vis[rb] = Math.max(0, Math.min(1, (db - gateDb) / dynDb));
    }

    // Splat across the beam, tapering to the edges.
    const halfBins = Math.max(1, Math.round((beamWidth / 2) / (2 * Math.PI) * this.angleBins));
    const centre = Math.round((bearing / (2 * Math.PI)) * this.angleBins);
    for (let d = -halfBins; d <= halfBins; d++) {
      const w = 0.5 * (1 + Math.cos((Math.PI * d) / (halfBins + 1)));
      let a = (centre + d) % this.angleBins;
      if (a < 0) a += this.angleBins;
      const base = a * this.rangeBins;
      if (w > 0.35) this.painted[a] = 1;
      for (let rb = 0; rb < this.rangeBins; rb++) {
        const v = vis[rb] * w;
        if (v > this.buf[base + rb]) this.buf[base + rb] = v;
      }
    }
    this.lastRangeBin = lastBin;
  }

  /** Fraction of the full circle swept recently, to prompt the user to turn. */
  get coverage() {
    let c = 0;
    for (let i = 0; i < this.angleBins; i++) if (this.painted[i] > 0.05) c++;
    return c / this.angleBins;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Size against the *parent* box and pin both CSS dimensions. Letting CSS
    // pick width and height independently gives a non-square element, and a
    // square backing store stretched into it draws the dial as an ellipse.
    const parent = this.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const style = getComputedStyle(parent);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const size = Math.max(64, Math.floor(Math.min(rect.width - padX, rect.height - padY)));

    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.canvas.width = Math.floor(size * dpr);
    this.canvas.height = Math.floor(size * dpr);
    this.cssSize = size;
    this.dpr = dpr;
  }

  /**
   * @param {number} heading current bearing, radians, for the sweep line
   */
  render(heading, { maxRange = this.maxRange, units = 'm', nearest = null, live = true } = {}) {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastRender) / 1000);
    this.lastRender = now;
    this.maxRange = maxRange;

    const decay = Math.exp(-dt / SWEEP_TAU);
    const buf = this.buf;
    for (let i = 0; i < buf.length; i++) buf[i] *= decay;
    for (let i = 0; i < this.painted.length; i++) this.painted[i] *= Math.exp(-dt / 12);

    this._renderPolar();

    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2;
    const rad = Math.min(W, H) / 2 - 2;

    ctx.save();
    ctx.clearRect(0, 0, W, H);

    // Faint radial backdrop so the dial reads as a surface, not a void.
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    bg.addColorStop(0, 'rgba(10,32,24,0.95)');
    bg.addColorStop(1, 'rgba(4,14,12,0.95)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, 2 * Math.PI);
    ctx.fill();

    // The accumulated returns.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, 2 * Math.PI);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.polar, cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.restore();

    this._drawGrid(ctx, cx, cy, rad, maxRange, units);
    if (live) this._drawSweep(ctx, cx, cy, rad, heading);
    if (nearest) this._drawNearest(ctx, cx, cy, rad, nearest, maxRange, units);
    this._drawDevice(ctx, cx, cy, rad);

    ctx.restore();
  }

  _renderPolar() {
    const data = this.image.data;
    const lut = this.lut;
    const buf = this.buf;
    for (let p = 0, i = 0; p < lut.length; p++, i += 4) {
      const idx = lut[p];
      if (idx < 0) { data[i + 3] = 0; continue; }
      const v = buf[idx];
      if (v <= 0.004) { data[i + 3] = 0; continue; }
      // Phosphor ramp: deep green at threshold, whitening as it gets strong.
      const hot = v > 0.62 ? (v - 0.62) / 0.38 : 0;
      data[i] = 40 + 215 * hot * hot;
      data[i + 1] = 90 + 165 * Math.min(1, v * 1.25);
      data[i + 2] = 70 + 150 * hot;
      data[i + 3] = 255 * Math.min(1, v * 1.5);
    }
    this.polarCtx.putImageData(this.image, 0, 0);
  }

  _drawGrid(ctx, cx, cy, rad, maxRange, units) {
    const scale = this.dpr || 1;
    const toUnits = (m) => (units === 'ft' ? m * 3.28084 : m);
    const suffix = units === 'ft' ? 'ft' : 'm';

    // Pick a ring spacing that yields roughly four rings.
    const candidates = units === 'ft' ? [1, 2, 5, 10, 20] : [0.25, 0.5, 1, 2, 5];
    const span = toUnits(maxRange);
    const step = candidates.find((c) => span / c <= 5) ?? candidates[candidates.length - 1];

    ctx.lineWidth = 1 * scale;
    ctx.font = `${11 * scale}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let r = step; r <= span + 1e-9; r += step) {
      const rr = (r / span) * rad;
      ctx.strokeStyle = 'rgba(90,220,170,0.18)';
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, 2 * Math.PI);
      ctx.stroke();
      // Labels run down-and-right from the centre, clear of the AHEAD marker
      // and of the sweep line's usual resting place.
      ctx.fillStyle = 'rgba(140,240,200,0.55)';
      ctx.fillText(`${Number(r.toFixed(2))}${suffix}`,
        cx + rr * 0.34 + 4 * scale, cy + rr * 0.94);
    }

    // Bearing ticks every 30 degrees, longer at the quadrants.
    for (let d = 0; d < 360; d += 15) {
      const th = (d * Math.PI) / 180;
      const major = d % 90 === 0;
      const mid = d % 30 === 0;
      if (!mid && !major) continue;
      const len = major ? 14 : 8;
      const sx = Math.sin(th), cyy = -Math.cos(th);
      ctx.strokeStyle = major ? 'rgba(120,240,190,0.45)' : 'rgba(90,220,170,0.22)';
      ctx.beginPath();
      ctx.moveTo(cx + sx * rad, cy + cyy * rad);
      ctx.lineTo(cx + sx * (rad - len * scale), cy + cyy * (rad - len * scale));
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(120,240,190,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, 2 * Math.PI);
    ctx.stroke();

    // "Ahead" marker at the top.
    ctx.fillStyle = 'rgba(150,245,205,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `${10 * scale}px ui-monospace, Menlo, monospace`;
    ctx.fillText('AHEAD', cx, cy - rad + 6 * scale);
  }

  _drawSweep(ctx, cx, cy, rad, heading) {
    const scale = this.dpr || 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);

    const g = ctx.createLinearGradient(0, 0, 0, -rad);
    g.addColorStop(0, 'rgba(120,255,200,0)');
    g.addColorStop(1, 'rgba(120,255,200,0.55)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -rad);
    ctx.stroke();

    ctx.fillStyle = 'rgba(120,255,200,0.9)';
    ctx.beginPath();
    ctx.arc(0, -rad + 5 * scale, 3 * scale, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  _drawNearest(ctx, cx, cy, rad, nearest, maxRange, units) {
    if (nearest.range > maxRange) return;
    const scale = this.dpr || 1;
    const rr = (nearest.range / maxRange) * rad;
    const th = nearest.bearing;
    const x = cx + Math.sin(th) * rr;
    const y = cy - Math.cos(th) * rr;

    ctx.strokeStyle = 'rgba(255,225,120,0.9)';
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.arc(x, y, 9 * scale, 0, 2 * Math.PI);
    ctx.stroke();

    const label = units === 'ft'
      ? `${(nearest.range * 3.28084).toFixed(1)} ft`
      : `${nearest.range.toFixed(2)} m`;
    ctx.fillStyle = 'rgba(255,235,160,0.95)';
    ctx.font = `${12 * scale}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, y - 13 * scale);
  }

  _drawDevice(ctx, cx, cy, rad) {
    const scale = this.dpr || 1;
    ctx.fillStyle = 'rgba(160,255,215,0.85)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7 * scale);
    ctx.lineTo(cx + 5 * scale, cy + 5 * scale);
    ctx.lineTo(cx, cy + 2 * scale);
    ctx.lineTo(cx - 5 * scale, cy + 5 * scale);
    ctx.closePath();
    ctx.fill();
  }
}
