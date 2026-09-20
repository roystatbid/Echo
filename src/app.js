import { BANDS, rangeResolution } from './chirp.js';
import { Sonar, DEFAULTS } from './sonar.js';
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
  bandHint: $('band-hint'), splashError: $('splash-error'),
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

function updateDiagnostics() {
  const rate = pingRate();
  const b = sonar?.band ?? BANDS[settings.band];
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
    await sonar.calibrate();
    radar?.clear();
    toast('Calibrated — the device’s own sound is now subtracted');
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
  if (key === 'maxRange' || key === 'band') { radar?.clear(); scope?.clear(); }
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
