import { BANDS, rangeResolution } from './chirp.js';
import { Sonar, DEFAULTS, SPEAKERS } from './sonar.js';
import { SimulatedSonar } from './simulator.js';
import { HeadingSource, wrapAngle } from './heading.js';
import { RadarDisplay } from './radar.js';
import { ScopeDisplay } from './scope.js';

const STORE_KEY = 'echo.settings.v1';

const DISPLAY_DEFAULTS = {
  gateDb: 12,
  dynDb: 26,
  tvg: 1.2,
  beamWidth: 40,   // degrees
  units: 'm',
};

const $ = (id) => document.getElementById(id);

const ui = {
  splash: $('splash'), app: $('app'), status: $('status'),
  radar: $('radar'), scope: $('scope'),
  rangeBig: $('range-big'), rangeSub: $('range-sub'), hint: $('hint'),
  settings: $('settings'), diagnostics: $('diagnostics'), toast: $('toast'),
  bandHint: $('band-hint'), speakerHint: $('speaker-hint'),
  micRow: $('row-mic'), micHint: $('mic-hint'), splashError: $('splash-error'),
};

const settings = loadSettings();

let sonar = null;
let heading = null;
let radar = null;
let scope = null;
let currentView = 'radar';
let nearest = null;          // { range, bearing, snrDb, at }
let pingTimes = [];
let lastStatus = { message: 'starting…' };
let lastProfile = null;
let announcedMics = false;
let wakeLock = null;

// ------------------------------------------------------------------ settings

function loadSettings() {
  const base = { ...DEFAULTS, ...DISPLAY_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...base, ...saved };
  } catch {
    return base;
  }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch {}
}

// --------------------------------------------------------------------- boot

$('btn-start').addEventListener('click', () => begin(false));
$('btn-demo').addEventListener('click', () => begin(true));

/**
 * iOS grants motion and microphone access only from inside a user gesture, and
 * the gesture is spent on the first `await`. Both requests are therefore
 * kicked off synchronously here, before anything is awaited.
 */
async function begin(simulated) {
  ui.splashError.hidden = true;

  const motionPromise = HeadingSource.needsPermission()
    ? HeadingSource.requestPermission().catch(() => 'denied')
    : Promise.resolve('granted');

  sonar = simulated ? new SimulatedSonar(settings) : new Sonar(settings);
  // Wire the callbacks before starting, or the first status messages (and, in
  // the simulator, the first pings) are emitted into the void.
  sonar.onStatus = onStatus;
  sonar.onProfile = onProfile;
  if (simulated) sonar.getBearing = () => heading?.heading ?? 0;
  const audioPromise = sonar.start();

  let motion = 'denied';
  try {
    [motion] = await Promise.all([motionPromise, audioPromise]);
  } catch (err) {
    ui.splashError.textContent =
      `${err.message}. Microphone access is required — check Settings › Safari › Microphone, ` +
      `or try the simulator to see how it works.`;
    ui.splashError.hidden = false;
    sonar = null;
    return;
  }

  heading = new HeadingSource();
  if (motion === 'granted') heading.start();

  ui.splash.hidden = true;
  ui.app.hidden = false;

  radar = new RadarDisplay(ui.radar);
  scope = new ScopeDisplay(ui.scope);
  sizeCanvases();

  buildSettingsPanel();
  requestWakeLock();
  requestAnimationFrame(frame);

  if (motion !== 'granted') {
    toast('Motion access denied — the dial can’t sweep, but ranging still works.');
  }
}

// ------------------------------------------------------------------ signals

function onProfile(profile) {
  const bearing = heading?.heading ?? 0;

  pingTimes.push(profile.time);
  if (pingTimes.length > 40) pingTimes.shift();

  radar.paint(profile, bearing, {
    beamWidth: (settings.beamWidth * Math.PI) / 180,
    gateDb: settings.gateDb,
    dynDb: settings.dynDb,
    tvg: settings.tvg,
    maxRange: settings.maxRange,
  });

  // Feed the waterfall whichever tab is showing. It costs a few hundred writes
  // per ping and means switching to the Signal tab reveals the last twenty
  // seconds rather than an empty panel.
  scope.push(profile, {
    gateDb: settings.gateDb, dynDb: settings.dynDb,
    tvg: settings.tvg, maxRange: settings.maxRange,
  });

  const best = profile.peaks[0];
  if (best) {
    nearest = { range: best.range, bearing, snrDb: best.snrDb, at: profile.time };
  } else if (nearest && profile.time - nearest.at > 1500) {
    nearest = null;
  }

  lastProfile = profile;

  // Worth surfacing rather than leaving buried in Diagnostics: two genuinely
  // different microphones would make real bearing possible without turning.
  if (!announcedMics && sonar?.channelInfo?.verdict === 'distinct') {
    announcedMics = true;
    toast('Two distinct microphone channels detected — see Diagnostics');
  }
}

function onStatus(s) {
  lastStatus = s;
  ui.status.textContent = s.message;
  ui.status.className = 'status' + (s.fatal ? ' bad' : s.state === 'locking' ? ' warn' : '');
}

// ------------------------------------------------------------------- render

function frame() {
  const h = heading?.heading ?? 0;

  if (currentView === 'radar') {
    radar.render(h, {
      maxRange: settings.maxRange,
      units: settings.units,
      nearest,
      live: sonar?.state === 'running',
    });
    updateReadout();
    updateHint();
  } else {
    scope.render({ units: settings.units, maxRange: settings.maxRange });
  }

  if (!ui.settings.hidden) updateDiagnostics();
  requestAnimationFrame(frame);
}

function fmt(metres) {
  return settings.units === 'ft'
    ? `${(metres * 3.28084).toFixed(1)} ft`
    : `${metres.toFixed(2)} m`;
}

function updateReadout() {
  if (!nearest) {
    ui.rangeBig.textContent = '—';
    ui.rangeSub.textContent = sonar?.state === 'running' ? 'nothing in range' : '';
    return;
  }
  ui.rangeBig.textContent = fmt(nearest.range);
  const deg = Math.round((wrapAngle(nearest.bearing) * 180) / Math.PI);
  ui.rangeSub.textContent = `${deg.toString().padStart(3, '0')}°  ·  ${nearest.snrDb.toFixed(0)} dB`;
}

function updateHint() {
  let msg = '';
  if (lastProfile?.clipping) {
    msg = 'Input is clipping — turn the volume down.';
  } else if (sonar?.state === 'locking') {
    msg = 'Turn the volume up so the iPad can hear its own chirp.';
  } else if (!sonar?.calibrated && !sonar?.simulated) {
    msg = 'Calibrate in open space to see anything closer than a metre.';
  } else if (heading && !heading.available) {
    msg = 'No motion data — the dial can’t sweep.';
  } else if (radar && radar.coverage < 0.55) {
    msg = 'Turn slowly on the spot to sweep the room.';
  }
  if (ui.hint.textContent !== msg) ui.hint.textContent = msg;
}

/**
 * What the audio thread actually delivered, which is the only trustworthy
 * answer: iOS routinely omits channelCount from getSettings(), and a missing
 * value says nothing at all about the hardware.
 */
function micChannels() {
  if (sonar?.simulated) return 'n/a (simulated)';
  const info = sonar?.channelInfo;
  if (!info || !info.count) return info?.verdict ?? '—';
  if (info.count === 1) return '1';
  if (info.verdict === 'distinct') {
    const c = info.correlation ?? 0;
    return `2, distinct (r=${c.toFixed(2)})`;
  }
  return `${info.count}, ${info.verdict}`;
}

/** Renders a getUserMedia constraint that we asked to be off. */
function flag(v) {
  if (v === undefined || v === null) return 'not reported';
  return v ? 'ON — bad' : 'off';
}

function updateDiagnostics() {
  const rate = pingRate();
  const b = sonar?.band ?? BANDS[settings.band];
  const ts = sonar?.trackSettings ?? {};
  const rows = [
    ['sample rate', sonar?.sampleRate ? `${(sonar.sampleRate / 1000).toFixed(1)} kHz` : '—'],
    ['band', `${(b.f0 / 1000).toFixed(1)}–${(b.f1 / 1000).toFixed(1)} kHz`],
    ['resolution', `${(rangeResolution(b.f1 - b.f0) * 100).toFixed(1)} cm`],
    ['ping rate', rate ? `${rate.toFixed(1)} /s` : '—'],
    ['audio round trip', lastProfile?.latencyMs ? `${lastProfile.latencyMs.toFixed(1)} ms` : '—'],
    ['input level', lastProfile ? `${(20 * Math.log10(Math.max(lastProfile.inputLevel, 1e-6))).toFixed(0)} dBFS` : '—'],
    ['clipping', lastProfile?.clipping ? 'YES' : 'no'],
    ['direct blast', lastProfile ? lastProfile.directAmp.toFixed(3) : '—'],
    ['noise floor', lastProfile ? lastProfile.noise.toExponential(1) : '—'],
    ['calibrated', sonar?.calibrated ? 'yes' : 'no'],
    ['cancelling', lastProfile?.cancelled ? 'yes' : 'no'],
    ['speaker', settings.speaker],
    ['output channels', sonar?.outputChannels ?? '—'],
    ['second pulse', sonar?.lastCalibration?.secondaryPulse
      ? `${(sonar.lastCalibration.secondaryPulse.pathMetres * 100).toFixed(0)} cm`
      : (sonar?.lastCalibration ? 'none' : '—')],
    ['mic channels', micChannels()],
    ['audio inputs', sonar?.simulated ? 'n/a (simulated)' : (sonar?.microphones?.length ?? '—')],
    // iOS is asked to turn these off; whether it did can only be seen here.
    ['echo cancel', flag(ts.echoCancellation)],
    ['auto gain', flag(ts.autoGainControl)],
    ['noise suppress', flag(ts.noiseSuppression)],
    ['heading source', heading?.mode ?? 'none'],
    ['screen angle', heading ? `${heading.screenAngle}°` : '—'],
    ['coverage', radar ? `${Math.round(radar.coverage * 100)}%` : '—'],
  ];
  ui.diagnostics.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
}

function pingRate() {
  if (pingTimes.length < 4) return 0;
  const span = (pingTimes[pingTimes.length - 1] - pingTimes[0]) / 1000;
  return span > 0 ? (pingTimes.length - 1) / span : 0;
}

// -------------------------------------------------------------------- chrome

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    currentView = tab.dataset.view;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('view-radar').hidden = currentView !== 'radar';
    $('view-scope').hidden = currentView !== 'scope';
    sizeCanvases();
  });
});

$('btn-settings').addEventListener('click', () => { ui.settings.hidden = false; });
$('btn-close-settings').addEventListener('click', () => { ui.settings.hidden = true; });

$('btn-ahead').addEventListener('click', () => {
  heading?.zero();
  radar?.clear();
  toast('This direction is now straight ahead');
});

// Which physical end of the iPad a channel comes out of depends on the model
// and on how it is being held, so the only reliable way to pick is to try the
// other one. That deserves to be one tap, not a trip into Settings.
$('btn-swap').addEventListener('click', () => {
  const next = settings.speaker === 'right' ? 'left' : 'right';
  applySetting('speaker', next);
  radar?.clear();
  scope?.clear();
  const sel = $('opt-speaker');
  if (sel) sel.value = next;
  if (ui.speakerHint) ui.speakerHint.textContent = SPEAKERS[next].hint;
  toast(`${SPEAKERS[next].label} — recalibrate once you've settled on one`);
});

$('btn-clear').addEventListener('click', () => {
  radar?.clear();
  scope?.clear();
  nearest = null;
});

$('btn-stop').addEventListener('click', () => {
  sonar?.stop();
  heading?.stop();
  releaseWakeLock();
  ui.app.hidden = true;
  ui.splash.hidden = false;
  sonar = null;
});

$('btn-calibrate').addEventListener('click', async () => {
  if (!sonar) return;
  try {
    const result = await sonar.calibrate();
    radar?.clear();

    // Whether the channel routing actually took effect can only be discovered
    // on the hardware, so report what the calibration measured rather than
    // assuming.
    const second = result?.secondaryPulse;
    if (second && settings.speaker !== 'both') {
      toast(`Second pulse ${(second.pathMetres * 100).toFixed(0)} cm behind — try the other speaker`);
    } else if (second) {
      toast(`Both speakers firing, ${(second.pathMetres * 100).toFixed(0)} cm apart — pick one`);
    } else {
      toast('Calibrated — the device’s own sound is now subtracted');
    }
  } catch (err) {
    toast(`Couldn’t calibrate: ${err.message}`);
  }
});

$('btn-reset').addEventListener('click', () => {
  Object.assign(settings, DEFAULTS, DISPLAY_DEFAULTS);
  saveSettings();
  for (const [k, v] of Object.entries(settings)) applySetting(k, v, false);
  buildSettingsPanel();
  toast('Settings reset');
});

let toastTimer = null;
function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2600);
}

// ------------------------------------------------------------------ controls

const SLIDERS = {
  maxRange: { fmt: (v) => `${v} m` },
  pingRate: { fmt: (v) => `${v}/s` },
  volume: { fmt: (v) => `${Math.round(v * 100)}%` },
  cfarScale: { fmt: (v) => v.toFixed(2) },
  gateDb: { fmt: (v) => `${v} dB` },
  beamWidth: { fmt: (v) => `${v}°` },
  blindRange: { fmt: (v) => `${v.toFixed(2)} m` },
  speakerMic: { fmt: (v) => `${(v * 100).toFixed(0)} cm` },
};

function buildSettingsPanel() {
  const bandSel = $('opt-band');
  bandSel.innerHTML = Object.entries(BANDS)
    .map(([key, b]) => `<option value="${key}">${b.label} · ${(b.f0 / 1000).toFixed(0)}–${(b.f1 / 1000).toFixed(0)} kHz</option>`)
    .join('');
  bandSel.value = settings.band;
  ui.bandHint.textContent = BANDS[settings.band].hint;
  bandSel.onchange = () => {
    applySetting('band', bandSel.value);
    ui.bandHint.textContent = BANDS[bandSel.value].hint;
  };

  // Only worth showing if the platform actually offers a choice. iOS often
  // reports a single generic input even on hardware with several microphones.
  const mics = sonar?.microphones ?? [];
  if (mics.length > 1) {
    const micSel = $('opt-mic');
    micSel.innerHTML = mics
      .map((m) => `<option value="${m.deviceId}">${m.label}</option>`)
      .join('');
    micSel.value = settings.micDeviceId || mics[0].deviceId;
    ui.micRow.hidden = false;
    ui.micHint.hidden = false;
    ui.micHint.textContent =
      'The microphone is part of the geometry — a different one sits a different '
      + 'distance from the speaker. Switching drops the calibration and re-locks.';
    micSel.onchange = async () => {
      settings.micDeviceId = micSel.value;
      saveSettings();
      try {
        await sonar.switchMicrophone(micSel.value);
        radar?.clear();
        scope?.clear();
        toast('Microphone changed — recalibrate');
      } catch (err) {
        toast(`Couldn’t switch microphone: ${err.message}`);
      }
    };
  }

  const spkSel = $('opt-speaker');
  spkSel.innerHTML = Object.entries(SPEAKERS)
    .map(([key, s]) => `<option value="${key}">${s.label}</option>`)
    .join('');
  spkSel.value = settings.speaker;
  ui.speakerHint.textContent = SPEAKERS[settings.speaker].hint;
  spkSel.onchange = () => {
    applySetting('speaker', spkSel.value);
    ui.speakerHint.textContent = SPEAKERS[spkSel.value].hint;
  };

  for (const [key, spec] of Object.entries(SLIDERS)) {
    const input = $(`opt-${key}`);
    const out = $(`out-${key}`);
    if (!input) continue;
    input.value = settings[key];
    out.textContent = spec.fmt(Number(settings[key]));
    input.oninput = () => {
      const v = Number(input.value);
      out.textContent = spec.fmt(v);
      applySetting(key, v);
    };
  }

  const cancel = $('opt-cancelDirect');
  cancel.checked = !!settings.cancelDirect;
  cancel.onchange = () => applySetting('cancelDirect', cancel.checked);

  const units = $('opt-units');
  units.checked = settings.units === 'ft';
  units.onchange = () => applySetting('units', units.checked ? 'ft' : 'm');
}

/** Display-only settings never touch the sonar engine. */
const DISPLAY_ONLY = new Set(['gateDb', 'dynDb', 'tvg', 'beamWidth', 'units']);

function applySetting(key, value, persist = true) {
  settings[key] = value;
  if (!DISPLAY_ONLY.has(key)) sonar?.set(key, value);
  if (['maxRange', 'band', 'speaker'].includes(key)) { radar?.clear(); scope?.clear(); }
  if (persist) saveSettings();
}

// ------------------------------------------------------------------ plumbing

function sizeCanvases() {
  // Wait a frame so the freshly-shown view has been laid out.
  requestAnimationFrame(() => {
    radar?.resize();
    scope?.resize();
  });
}

window.addEventListener('resize', sizeCanvases);
window.addEventListener('orientationchange', sizeCanvases);
screen.orientation?.addEventListener?.('change', sizeCanvases);

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch {}
  wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !sonar) return;
  if (!wakeLock) requestWakeLock();
  // iOS suspends the AudioContext while backgrounded, which stops both the
  // chirps and the capture. Resuming leaves the latency lock stale, so drop it
  // and let the next few pings find the direct blast again.
  if (sonar.ctx?.state === 'suspended') {
    try {
      await sonar.ctx.resume();
      sonar.latency = null;
      sonar.state = 'locking';
    } catch {}
  }
});

// Stop the page bouncing under a dragging finger on iOS.
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.settings-body') && e.cancelable) e.preventDefault();
}, { passive: false });
