import { nextPow2 } from './fft.js';
import { BANDS, SPEED_OF_SOUND, makeChirp, rangeResolution } from './chirp.js';
import { MatchedFilter, magnitude, argMax, parabolicPeak, medianOf } from './dsp.js';
import { PingAnalyzer } from './ranging.js';

/**
 * The recorder runs in an AudioWorklet so capture is stamped with the audio
 * hardware clock rather than the main thread's. That stamp is what lets us
 * line a recording up against a chirp scheduled for a given AudioContext time.
 *
 * SharedArrayBuffer would be tidier but needs COOP/COEP headers that GitHub
 * Pages can't set, so we transfer buffers instead. At ~47 messages a second
 * that costs nothing measurable.
 */
const RECORDER_WORKLET = `
class EchoRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunk = (options.processorOptions && options.processorOptions.chunk) || 1024;
    this.buf = new Float32Array(this.chunk);
    this.fill = 0;
    this.chunkStart = currentFrame;
  }
  process(inputs) {
    // Re-stamp at each chunk boundary, so a dropped render quantum shows up as
    // a gap in frame numbers instead of silently shifting everything after it.
    if (this.fill === 0) this.chunkStart = currentFrame;
    const ch = inputs[0] && inputs[0][0];
    const n = ch ? ch.length : 128;
    for (let i = 0; i < n; i++) {
      this.buf[this.fill++] = ch ? ch[i] : 0;
      if (this.fill === this.chunk) {
        this.port.postMessage({ frame: this.chunkStart, data: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(this.chunk);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('echo-recorder', EchoRecorder);
`;

const RING_SECONDS = 4;
const CHUNK = 1024;
const LOCK_SPAN_SEC = 0.35;

export const DEFAULTS = {
  band: 'balanced',
  chirpMs: 5,
  maxRange: 6,
  pingRate: 10,
  volume: 0.6,
  speakerMic: 0.15,
  blindRange: 0.25,
  cancelDirect: true,
  cfarScale: 4.5,
};

/**
 * Drives the transmit/receive loop and hands finished range profiles to a
 * listener. All the actual measurement lives in PingAnalyzer; this class owns
 * the audio graph, the capture ring, and the latency lock.
 */
export class Sonar {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.state = 'idle'; // idle | starting | locking | running | error
    this.onProfile = null;
    this.onStatus = null;
    this.seq = 0;
    this.latency = null; // frames from transmit to the direct blast
    this.lastError = null;
    this.calibration = null;
  }

  get band() { return BANDS[this.opts.band] ?? BANDS.balanced; }
  get resolution() { const b = this.band; return rangeResolution(b.f1 - b.f0); }
  get calibrated() { return !!this.analyzer?.clutter; }

  _status(msg, extra = {}) {
    this.onStatus?.({ state: this.state, message: msg, ...extra });
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (this.state !== 'idle' && this.state !== 'error') return;
    this.state = 'starting';
    this._status('Requesting microphone…');

    try {
      // Every one of these constraints is load-bearing. iOS defaults to a
      // voice-processing chain whose echo canceller exists precisely to remove
      // what we are trying to measure, and whose AGC would undo any attempt to
      // compare echo strength between pings.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.state = 'error';
      this.lastError = err;
      this._status(`Microphone unavailable: ${err.message}`, { fatal: true });
      throw err;
    }

    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;

    // Record what the browser actually granted; iOS quietly ignores some of it.
    const track = this.stream.getAudioTracks()[0];
    this.trackSettings = track?.getSettings?.() ?? {};

    const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'application/javascript' }));
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.ringLen = nextPow2(RING_SECONDS * this.sampleRate);
    this.ringMask = this.ringLen - 1;
    this.ring = new Float32Array(this.ringLen);
    this.ringWrite = 0;
    this.ringStarted = false;

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.recorder = new AudioWorkletNode(this.ctx, 'echo-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { chunk: CHUNK },
    });
    this.recorder.port.onmessage = (e) => this._onAudio(e.data);

    // Some browsers stop pulling a worklet that isn't wired to the destination.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.source.connect(this.recorder);
    this.recorder.connect(this.mute).connect(this.ctx.destination);

    this.outGain = this.ctx.createGain();
    this.outGain.gain.value = this.opts.volume;
    this.outGain.connect(this.ctx.destination);

    this._buildWaveform();

    this.pending = [];
    this.nextTxTime = this.ctx.currentTime + 0.25;
    this.latency = null;
    this.state = 'locking';
    this._status('Listening for the direct pulse…');
    this.timer = setInterval(() => this._tick(), 15);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.source?.disconnect(); this.recorder?.disconnect(); this.outGain?.disconnect(); } catch {}
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
    this.state = 'idle';
    this.latency = null;
    this._status('Stopped');
  }

  /** Change a setting live. Some of them mean rebuilding the transmit pulse. */
  set(key, value) {
    const wasCalibrated = this.calibrated;
    this.opts[key] = value;

    if (key === 'volume' && this.outGain) {
      this.outGain.gain.value = value;
      return;
    }
    if (!this.ctx) return;

    if (['band', 'chirpMs', 'maxRange', 'speakerMic', 'blindRange'].includes(key)) {
      const rebuildPulse = ['band', 'chirpMs'].includes(key);
      this._buildWaveform();
      if (rebuildPulse && wasCalibrated) {
        // The calibration was measured with the old pulse; it can't subtract
        // from profiles made with a new one.
        this._status('Pulse changed — recalibrate for best results');
      }
      if (rebuildPulse) {
        this.latency = null;
        this.state = 'locking';
      }
    } else if (key === 'cfarScale' && this.analyzer) {
      this.analyzer.cfarScale = value;
    }
  }

  // ------------------------------------------------------------- transmit path

  _buildWaveform() {
    const sr = this.sampleRate;
    const b = this.band;
    this.chirp = makeChirp({
      sampleRate: sr, f0: b.f0, f1: b.f1,
      duration: this.opts.chirpMs / 1000, taper: 0.3,
    });
    this.chirpBuffer = this.ctx.createBuffer(1, this.chirp.length, sr);
    this.chirpBuffer.copyToChannel(this.chirp, 0);

    this.analyzer = new PingAnalyzer({
      sampleRate: sr, chirp: this.chirp, f0: b.f0, f1: b.f1,
      maxRange: this.opts.maxRange,
      speakerMic: this.opts.speakerMic,
      blindRange: this.opts.blindRange,
      cfarScale: this.opts.cfarScale,
    });

    // Lock-on searches a wide span, because output-to-input latency is unknown
    // and varies hugely by device and route (speaker vs. Bluetooth vs. AirPlay).
    this.lockWindow = Math.round(LOCK_SPAN_SEC * sr);
    this.mfLock = new MatchedFilter(
      this.chirp, nextPow2(this.lockWindow + this.chirp.length),
      { sampleRate: sr, mode: 'window', f0: b.f0, f1: b.f1 });
  }

  _schedule(time) {
    const node = this.ctx.createBufferSource();
    node.buffer = this.chirpBuffer;
    node.connect(this.outGain);
    node.start(time);
    this.pending.push({ id: this.seq++, txFrame: Math.round(time * this.sampleRate) });
  }

  // -------------------------------------------------------------- receive path

  _onAudio({ frame, data }) {
    if (!this.ring) return;
    if (!this.ringStarted) { this.ringWrite = frame; this.ringStarted = true; }

    if (frame > this.ringWrite) {
      // Dropped audio. Zero-fill so frame indices stay meaningful rather than
      // letting every later measurement slide by the size of the gap.
      const gap = Math.min(frame - this.ringWrite, this.ringLen);
      for (let i = 0; i < gap; i++) this.ring[(this.ringWrite + i) & this.ringMask] = 0;
      this.ringWrite = frame;
    } else if (frame + data.length <= this.ringWrite) {
      return; // stale chunk, already covered
    }
    for (let i = 0; i < data.length; i++) this.ring[(frame + i) & this.ringMask] = data[i];
    this.ringWrite = frame + data.length;
  }

  _read(start, length, reuse) {
    if (!this.ringStarted) return null;
    if (start < this.ringWrite - this.ringLen) return null; // overwritten
    if (start + length > this.ringWrite) return null;       // not captured yet
    const dst = reuse?.length === length ? reuse : new Float32Array(length);
    for (let i = 0; i < length; i++) dst[i] = this.ring[(start + i) & this.ringMask];
    return dst;
  }

  _tick() {
    if (!this.ctx || (this.state !== 'locking' && this.state !== 'running')) return;
    const now = this.ctx.currentTime;

    // Ping slowly while locking: the search window is long, and overlapping
    // pings would make it ambiguous which blast we had found.
    const period = this.state === 'locking' ? 0.5 : 1 / this.opts.pingRate;
    while (this.nextTxTime < now + 0.15) {
      if (this.nextTxTime < now + 0.02) this.nextTxTime = now + 0.05;
      this._schedule(this.nextTxTime);
      this.nextTxTime += period;
    }

    while (this.pending.length) {
      if (this._processPing(this.pending[0]) === 'wait') break;
      this.pending.shift();
    }
  }

  _processPing(ping) {
    const a = this.analyzer;
    const locking = this.latency === null;
    const start = locking ? ping.txFrame : ping.txFrame + this.latency - a.preGuard;
    const length = locking ? this.lockWindow : a.windowLength;

    const rx = this._read(start, length, this._rxBuf);
    if (!rx) {
      // Abandon pings whose audio has already scrolled out of the ring.
      if (this.ringStarted && start + length < this.ringWrite - this.ringLen) return 'drop';
      return 'wait';
    }
    this._rxBuf = rx;

    if (locking) return this._tryLock(rx, length);

    const profile = a.analyze(rx, { cancel: this.opts.cancelDirect });
    if (profile.error) {
      if (profile.error === 'no direct pulse') {
        // Route change, volume down, or a hand over the speaker.
        this.latency = null;
        this.state = 'locking';
        this._status('Lost the direct pulse — re-locking…');
      }
      return 'drop';
    }

    // Track slow drift so the profile origin stays put.
    this.latency += profile.directIndex - a.preGuard;

    if (this.calibration) this._collect(rx, length);

    profile.seq = ping.id;
    profile.time = performance.now();
    profile.latencyMs = (this.latency / this.sampleRate) * 1000;
    this.onProfile?.(profile);
    return 'done';
  }

  /**
   * Find the direct blast anywhere in a wide window, which pins down the audio
   * stack's output-to-input latency. Everything after this is measured relative
   * to that blast, so the latency never has to be known accurately again.
   */
  _tryLock(rx, length) {
    const { re, im } = this.mfLock.run(rx);
    const env = magnitude(re, im, null, 0, length);
    const idx = argMax(env, 1, length - 2);
    const noise = medianOf(env, 0, length);
    const pk = parabolicPeak(env, idx);

    if (pk.val < 8 * noise || idx < 2 || idx > length - 4) {
      this._status('Searching for the direct pulse — is the volume up?');
      return 'drop';
    }
    this.latency = idx;
    this.state = 'running';
    this._status(`Locked on. Audio round trip ${(idx / this.sampleRate * 1000).toFixed(1)} ms.`,
      { latencyMs: (idx / this.sampleRate) * 1000 });
    return 'done';
  }

  // ------------------------------------------------------------- calibration

  /**
   * Learn the device's own acoustic signature. Hold the iPad away from
   * surfaces while this runs; anything in view gets treated as part of the
   * hardware and subtracted out from then on.
   */
  calibrate(pings = 24) {
    if (this.state !== 'running') return Promise.reject(new Error('Not locked on yet'));
    return new Promise((resolve, reject) => {
      this.calibration = { want: pings, windows: [], resolve, reject };
      this._status('Calibrating — hold the iPad away from walls…', { calibrating: 0 });
    });
  }

  clearCalibration() {
    this.analyzer?.clearCalibration();
    this._status('Calibration cleared');
  }

  _collect(rx, length) {
    const cal = this.calibration;
    cal.windows.push(rx.slice(0, length));
    this._status(`Calibrating… ${cal.windows.length}/${cal.want}`,
      { calibrating: cal.windows.length / cal.want });
    if (cal.windows.length < cal.want) return;

    this.calibration = null;
    try {
      const result = this.analyzer.calibrateFrom(cal.windows);
      this._status('Calibrated', { calibrated: true });
      cal.resolve(result);
    } catch (err) {
      this._status(`Calibration failed: ${err.message}`);
      cal.reject(err);
    }
  }
}

export { SPEED_OF_SOUND, BANDS };
