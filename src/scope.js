import { toDb } from './dsp.js';

/**
 * The unembellished view of what the sensor actually measures.
 *
 * Top: echo strength against distance for the latest ping, with the CFAR
 * threshold drawn on top of it, so it's visible *why* something was or wasn't
 * called a wall.
 *
 * Bottom: the same trace stacked over time. Walking towards a wall draws a
 * diagonal streak, which is the most convincing demonstration that any of this
 * is real.
 */
export class ScopeDisplay {
  constructor(canvas, { waterfallRows = 220, rangeBins = 320 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rows = waterfallRows;
    this.bins = rangeBins;

    this.fall = document.createElement('canvas');
    this.fall.width = rangeBins;
    this.fall.height = waterfallRows;
    this.fallCtx = this.fall.getContext('2d');
    this.fallImage = this.fallCtx.createImageData(rangeBins, waterfallRows);
    this._blankFall();
    this.fallCtx.putImageData(this.fallImage, 0, 0);
    this.times = [];

    this.latest = null;
    this.maxRange = 6;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.dpr = dpr;
  }

  _blankFall() {
    const d = this.fallImage.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 5; d[i + 1] = 12; d[i + 2] = 11; d[i + 3] = 255;
    }
  }

  clear() {
    this._blankFall();
    this.fallCtx.putImageData(this.fallImage, 0, 0);
    this.latest = null;
    this.times = [];
  }

  /** Seconds of history the waterfall currently holds, at the observed rate. */
  get spanSeconds() {
    if (this.times.length < 4) return 0;
    const dt = (this.times[this.times.length - 1] - this.times[0]) / 1000;
    const rate = dt > 0 ? (this.times.length - 1) / dt : 0;
    return rate > 0 ? this.rows / rate : 0;
  }

  push(profile, { gateDb = 12, dynDb = 26, tvg = 1.2, maxRange = this.maxRange } = {}) {
    this.latest = profile;
    this.maxRange = maxRange;
    this.times.push(profile.time);
    if (this.times.length > this.rows) this.times.shift();

    // Scroll the waterfall up by one row, then draw the new ping at the bottom.
    const d = this.fallImage.data;
    const rowBytes = this.bins * 4;
    d.copyWithin(0, rowBytes);

    const floor = Math.max(profile.noise, 1e-12);
    const base = (this.rows - 1) * rowBytes;
    const { strength, blindBins } = profile;

    for (let x = 0; x < this.bins; x++) {
      const r = (x / this.bins) * maxRange;
      const i = this._binFor(profile, r);
      let v = 0;
      if (i !== null && i >= blindBins) {
        // Gate on raw SNR first. Compensating for spreading loss *before* the
        // gate lifts the noise floor at long range above it, and the far half
        // of the waterfall turns into a solid green wash.
        const snr = toDb(strength[i] / floor);
        if (snr >= gateDb) {
          const db = snr + tvg * 20 * Math.log10(Math.max(1, r));
          v = Math.max(0, Math.min(1, (db - gateDb) / dynDb));
        }
      }
      const o = base + x * 4;
      const hot = v > 0.62 ? (v - 0.62) / 0.38 : 0;
      // Floor at the same near-black as an unwritten row, so "nothing here"
      // and "no data yet" read the same instead of banding.
      d[o] = 5 + 250 * hot * hot;
      d[o + 1] = 12 + 230 * Math.min(1, v * 1.3);
      d[o + 2] = 11 + 170 * hot;
      d[o + 3] = 255;
    }
    this.fallCtx.putImageData(this.fallImage, 0, 0);
  }

  /** Profile sample index for a range in metres, or null if out of span. */
  _binFor(profile, r) {
    const n = profile.strength.length;
    const r0 = profile.binToRange(0);
    const r1 = profile.binToRange(n - 1);
    if (r < r0 || r > r1) return null;
    const i = Math.round(((r - r0) / (r1 - r0)) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  }

  render({ units = 'm', maxRange = this.maxRange } = {}) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const s = this.dpr || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060f0d';
    ctx.fillRect(0, 0, W, H);

    const padL = 42 * s, padR = 10 * s, padT = 10 * s;
    const plotW = W - padL - padR;
    const aH = Math.round((H - padT) * 0.46);
    const wY = padT + aH + 26 * s;
    const wH = H - wY - 22 * s;

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL - 40 * s, padT - 2 * s, plotW + 44 * s, aH + 4 * s);
    ctx.clip();
    this._drawAScope(ctx, padL, padT, plotW, aH, maxRange, units, s);
    ctx.restore();

    // Waterfall, newest at the bottom.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.fall, padL, wY, plotW, wH);
    ctx.strokeStyle = 'rgba(90,220,170,0.3)';
    ctx.lineWidth = 1 * s;
    ctx.strokeRect(padL, wY, plotW, wH);

    ctx.fillStyle = 'rgba(140,240,200,0.55)';
    ctx.font = `${10 * s}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('now', padL - 38 * s, wY + wH - 6 * s);
    const span = this.spanSeconds;
    ctx.fillText(span ? `-${Math.round(span)}s` : '', padL - 38 * s, wY + 8 * s);

    this._drawRangeAxis(ctx, padL, wY + wH, plotW, maxRange, units, s);
  }

  _drawAScope(ctx, x0, y0, w, h, maxRange, units, s) {
    const p = this.latest;
    ctx.strokeStyle = 'rgba(90,220,170,0.25)';
    ctx.lineWidth = 1 * s;
    ctx.strokeRect(x0, y0, w, h);

    const topDb = 54, botDb = -6;
    // Clamped, because the noise floor dips arbitrarily far below the axis and
    // an unclamped trace draws straight down over the waterfall beneath it.
    const yFor = (db) => {
      const t = Math.max(0, Math.min(1, (db - botDb) / (topDb - botDb)));
      return y0 + h - t * h;
    };

    for (let db = 0; db <= topDb; db += 12) {
      const y = yFor(db);
      ctx.strokeStyle = 'rgba(90,220,170,0.12)';
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(140,240,200,0.45)';
      ctx.font = `${10 * s}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${db}`, x0 - 6 * s, y);
    }
    ctx.save();
    ctx.translate(x0 - 30 * s, y0 + h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(140,240,200,0.5)';
    ctx.fillText('SNR dB', 0, 0);
    ctx.restore();

    if (!p) {
      ctx.fillStyle = 'rgba(140,240,200,0.4)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${12 * s}px ui-monospace, Menlo, monospace`;
      ctx.fillText('waiting for pings…', x0 + w / 2, y0 + h / 2);
      return;
    }

    const floor = Math.max(p.noise, 1e-12);
    const n = p.strength.length;
    const xFor = (r) => x0 + (r / maxRange) * w;

    // Blind zone: the direct blast and its ringdown live here.
    const blindX = xFor(p.binToRange(p.blindBins));
    ctx.fillStyle = 'rgba(255,120,120,0.07)';
    ctx.fillRect(x0, y0, Math.max(0, blindX - x0), h);
    ctx.strokeStyle = 'rgba(255,140,140,0.3)';
    ctx.setLineDash([3 * s, 3 * s]);
    ctx.beginPath();
    ctx.moveTo(blindX, y0);
    ctx.lineTo(blindX, y0 + h);
    ctx.stroke();
    ctx.setLineDash([]);

    // CFAR threshold: the bar a return has to clear to count as a wall.
    ctx.strokeStyle = 'rgba(255,190,90,0.6)';
    ctx.lineWidth = 1 * s;
    ctx.beginPath();
    let started = false;
    for (let i = p.blindBins; i < n; i++) {
      const r = p.binToRange(i);
      if (r > maxRange) break;
      const y = yFor(toDb(p.threshold[i] / floor));
      if (!started) { ctx.moveTo(xFor(r), y); started = true; } else ctx.lineTo(xFor(r), y);
    }
    ctx.stroke();

    // The trace itself.
    ctx.strokeStyle = 'rgba(120,255,200,0.95)';
    ctx.lineWidth = 1.25 * s;
    ctx.beginPath();
    started = false;
    for (let i = p.blindBins; i < n; i++) {
      const r = p.binToRange(i);
      if (r > maxRange) break;
      const y = yFor(toDb(p.strength[i] / floor));
      if (!started) { ctx.moveTo(xFor(r), y); started = true; } else ctx.lineTo(xFor(r), y);
    }
    ctx.stroke();

    // Detections. Every peak gets a ring; only the strongest few get a label,
    // and only where one won't land on top of another.
    ctx.font = `${10 * s}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const labelled = [];
    p.peaks.forEach((pk, rank) => {
      if (pk.range > maxRange) return;
      const x = xFor(pk.range);
      const y = yFor(pk.snrDb);
      ctx.strokeStyle = 'rgba(255,225,120,0.95)';
      ctx.lineWidth = 1.25 * s;
      ctx.beginPath();
      ctx.arc(x, y, 4 * s, 0, 2 * Math.PI);
      ctx.stroke();

      if (rank >= 4) return;
      if (labelled.some((lx) => Math.abs(lx - x) < 34 * s)) return;
      labelled.push(x);
      ctx.fillStyle = 'rgba(255,235,160,0.92)';
      ctx.fillText(units === 'ft' ? `${(pk.range * 3.28084).toFixed(1)}` : `${pk.range.toFixed(2)}`,
        x, y - 6 * s);
    });
  }

  _drawRangeAxis(ctx, x0, y, w, maxRange, units, s) {
    const toU = (m) => (units === 'ft' ? m * 3.28084 : m);
    const span = toU(maxRange);
    const candidates = units === 'ft' ? [1, 2, 5, 10, 20] : [0.25, 0.5, 1, 2, 5];
    const step = candidates.find((c) => span / c <= 8) ?? candidates[candidates.length - 1];

    ctx.fillStyle = 'rgba(140,240,200,0.55)';
    ctx.strokeStyle = 'rgba(90,220,170,0.3)';
    ctx.font = `${10 * s}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const unitLabel = units === 'ft' ? 'feet' : 'metres';
    const unitWidth = ctx.measureText(unitLabel).width;
    for (let r = 0; r <= span + 1e-9; r += step) {
      const x = x0 + (r / span) * w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 4 * s);
      ctx.stroke();
      // Skip the last number if the unit label would sit on top of it.
      if (x < x0 + w - unitWidth - 12 * s) ctx.fillText(`${Number(r.toFixed(2))}`, x, y + 6 * s);
    }
    ctx.textAlign = 'right';
    ctx.fillText(unitLabel, x0 + w, y + 6 * s);
  }
}
