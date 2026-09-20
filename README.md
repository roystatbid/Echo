# Echo

Acoustic echolocation for an iPad, using nothing but the speaker and microphone
it already has. Chirp, listen for the return, and turn the delay into a
distance. Turn slowly on the spot and the room paints itself.

Runs in Safari — no Xcode, no Mac, no provisioning profile.

## How it works

**Ranging.** The iPad emits a short linear frequency sweep. The sweep bounces
off whatever is in front of it and arrives back at the microphone a few
milliseconds later. Sound covers 343 m/s, so a wall at range `R` puts its echo
`2R/c` behind the outgoing pulse.

A click would be the obvious pulse to use, but a click puts all of its energy
into one instant, and to be audible over the room it would have to be loud
enough to overload the microphone. A sweep spreads the same energy over several
milliseconds, and a *matched filter* on receive squeezes it back into a single
spike. The compressed spike is as sharp as a click's would have been while
being far gentler on the hardware. Range resolution after compression is
`c / 2B` — about 1 cm across a 16 kHz sweep — and it depends on the bandwidth,
not on how long the chirp is.

**Bearing.** This is where the honesty comes in. One speaker and one microphone
measure distance and nothing else; there is no way to tell *which direction* an
echo came from. So the user is the scanning mechanism. The app reads the iPad's
orientation and paints each ping at the bearing the device was pointing when it
fired. Rotating on the spot sweeps the beam across the room exactly the way a
radar antenna does, just slower and powered by your feet. The angular width of
each blip on the dial is an assumption about how wide the speaker radiates, not
a measurement, and the app says so in the settings panel.

## The parts that are less obvious

**The direct blast is the clock.** The microphone hears the speaker directly,
long before any echo. That leak is usually treated as a nuisance; here it is the
most useful signal in the recording. Browsers and audio hardware introduce tens
of milliseconds of unknown, device-specific latency between asking for a sound
and capturing it, and that latency changes when the audio route changes.
Measuring every echo *relative to the direct blast* cancels it exactly, with no
calibration and no assumptions, and re-derives itself on every single ping.

**Sidelobes become phantom walls.** The textbook matched filter, `conj(REF)`,
compresses a linear sweep into a sinc-like pulse whose nearest sidelobes sit
only about 13 dB down. On a display, those read as extra walls a couple of
centimetres either side of every real one. Echo uses a *mismatched* filter
instead — divide by the reference's own power spectrum to flatten it, then
impose a deliberate Hamming taper across the sweep band. Sidelobes drop below
−45 dB for the same main-lobe width, at a cost of a fraction of a dB of
signal-to-noise:

| lag from the peak | 3 samples | 4 | 5 | 6 | 8 | 10 |
|---|---|---|---|---|---|---|
| plain matched filter | −13 dB | −23 | **−14** | −15 | −26 | −21 |
| mismatched (windowed) | −7 dB | −14 | −25 | **−49** | −59 | −53 |

**Calibration clears the near field.** After every chirp the case keeps ringing
for a few milliseconds, which is precisely the delay range where anything
closer than about a metre would show up. Hold the iPad in open space, tap
**Calibrate**, and the app records its own acoustic signature and does two
things with it:

1. Promotes the *recorded* blast to the matched-filter reference. That version
   carries the real speaker and microphone response, so it compresses tighter
   than the mathematically ideal sweep does.
2. Builds a clutter template — the blast plus the ringdown — and subtracts it
   coherently from every later ping, aligned to sub-sample phase and rescaled to
   the live blast so that turning the volume down doesn't leave a crater.

In simulation this drops the near-field clutter pedestal by more than 8× (about
30× at 0.3 m), which is the difference between seeing a wall at half a metre and
not.

**Detection is statistical, not a fixed threshold.** The noise floor varies
enormously across a single profile — huge just after the blast, tiny at long
range. Echo uses a smallest-of CFAR: for each range cell, estimate the noise
from the cells around it and require the return to stand a set factor above it.
"Smallest-of" specifically, because plain cell-averaging inflates the threshold
across the clutter edge at the end of the ringdown and hides genuinely close
walls.

The default threshold factor was picked by measurement rather than taste:

| factor | false alarms per ping | detection of a weak wall at 4.5 m |
|---|---|---|
| 3.5 | 1.10 | 100% |
| 4.0 | 0.32 | 100% |
| **4.5** | **0.14** | **99%** |
| 5.0 | 0.06 | 98% |
| 5.5 | 0.02 | 88% |

## Getting it on the iPad

The app is plain static files with no build step and no dependencies.

**GitHub Pages.** In the repository, go to *Settings → Pages*, set the source to
*Deploy from a branch*, and pick this branch with folder `/ (root)`. Open the
resulting URL in Safari. Pages serves over HTTPS, which the microphone API
requires.

**Locally**, for development:

```sh
npm run serve          # http://localhost:8080
```

Safari only grants microphone access over HTTPS or on `localhost`, so a plain
`file://` open will not work.

Once it's loaded, use Share → *Add to Home Screen* to get it full-screen without
Safari's chrome.

## Using it

1. **Start.** Grant microphone and motion access. Turn the volume most of the
   way up and take any headphones out — the iPad has to be able to hear itself.
2. **Calibrate.** Hold it away from walls, furniture and your own body, and tap
   *Calibrate*. Takes a couple of seconds. Without this, nothing closer than
   about a metre is visible.
3. **Set ahead.** Point the way you want "up" on the dial to mean, and tap it.
4. **Sweep.** Turn slowly and steadily on the spot. Quickly enough and you'll
   leave gaps between pings; the hint line tells you when coverage is thin.

The **Signal** tab shows what the sensor actually measured: echo strength
against distance, with the detection threshold drawn over it, plus a waterfall
of the last twenty seconds. Walking towards a wall draws a diagonal streak, and
it's the most convincing demonstration that any of this is real.

### Settings worth knowing about

| Setting | What it does |
|---|---|
| **Chirp band** | *Quiet* (14–21 kHz) is near-ultrasonic and most adults barely hear it — though children and dogs will. *Balanced* (6–20 kHz) is the best all-rounder. *Long* (2–18 kHz) is loud and annoying but reaches furthest. |
| **Volume** | Louder reaches further, but clipping the microphone destroys the measurement. Watch the clipping indicator. |
| **Sensitivity** | The CFAR factor from the table above. Lower finds fainter walls and invents more phantoms. |
| **Speaker↔mic spacing** | The physical gap between the speaker and microphone on your iPad. An echo arrives `(2R − d)/c` after the blast, so getting `d` wrong puts a constant bias of `d/2` on every reading. The 15 cm default is a reasonable guess; measure yours and it'll get more accurate. |
| **Blind zone** | Everything closer than this is ignored, because the speaker is still ringing. Lower it after calibrating. |

## Honest limitations

- **No angular resolution.** All bearing information comes from the gyroscope.
  A wall 30° off to the side and a wall straight ahead at the same distance are
  indistinguishable to the sensor; the dial spreads each ping over an assumed
  beam width. This is the fundamental limit of one speaker and one microphone.
- **iOS audio processing.** Safari is asked for `echoCancellation: false`,
  `autoGainControl: false` and `noiseSuppression: false`, because iOS's default
  voice-processing chain contains an echo canceller whose entire purpose is to
  remove exactly what we're trying to measure. Safari mostly honours these, but
  not with the same certainty that a native `AVAudioSession` in `.measurement`
  mode would.
- **Range.** Realistically 0.3 m to 4–5 m against a hard flat wall. Soft
  furnishings, curtains and bookshelves absorb sound and may not return anything
  at all. A wall at a shallow angle reflects the sound away from you rather than
  back, and vanishes.
- **Output level.** While the microphone is live, iOS may route audio more
  quietly than usual. If the app can't find its own chirp it will say so.
- **Speed of sound** is assumed to be 343 m/s (roughly 20 °C). Cold air is
  slower; at 0 °C readings run about 2% long.

## Trying it without a microphone

*Try the simulator instead* on the opening screen invents a 5 × 4 m room with a
desk and a cupboard in it, synthesises the received audio, and pushes it through
the real analysis chain — the same matched filter, CFAR and peak detection that
live audio gets. Useful for seeing what a clean signal is supposed to look like
before blaming the room.

## Layout

```
src/fft.js         radix-2 FFT, no dependencies
src/chirp.js       transmit waveform, bands, range/time conversions
src/dsp.js         matched filter, analytic envelope, CFAR, peak interpolation
src/ranging.js     one recorded window -> one range profile (no Web Audio)
src/sonar.js       audio graph, capture ring, latency lock, calibration
src/simulator.js   a fake room that drives the real analysis chain
src/heading.js     device orientation -> bearing
src/radar.js       polar accumulation display
src/scope.js       A-scope and waterfall
src/app.js         wiring, settings, permissions
```

`ranging.js` deliberately knows nothing about Web Audio. That's what makes it
possible to drive the whole measurement chain from a simulated room in tests
instead of only being able to observe it on the device.

## Tests

```sh
npm test
```

44 tests, no dependencies. They cover the FFT against a naive DFT, range
accuracy to within 1.5 cm across 0.4 m to 4.8 m, separating two walls one
resolution cell apart, sidelobe level, CFAR false-alarm rate, clutter
suppression, behaviour when the output level changes mid-session, and the
orientation maths across device poses.

The orientation tests are worth a particular mention: the bearing calculation
blends "up the screen" with "out the back of the slab" according to how the iPad
is being held, and it uses the screen's own up direction rather than the
device's physical top edge. An iPad standing upright in landscape has its top
edge horizontal, and blending *that* with the back direction lands 45° off —
a bug that would have been invisible until someone rotated the device.

## Porting to Swift later

The measurement code is ordinary array maths and ports directly. What changes:

- `AVAudioSession` in `.measurement` mode genuinely disables AGC, noise
  suppression and echo cancellation, rather than requesting it politely.
- `AVAudioSession.outputLatency` and `inputLatency` are available, though the
  direct-blast time origin makes them unnecessary.
- vDSP/Accelerate for the FFT and correlation, which matters if you want a
  higher ping rate or a longer profile.
- `CMMotionManager` gives attitude as a quaternion with no gimbal-lock
  awkwardness, replacing the Euler-angle handling in `heading.js`.

The signal chain itself — sweep, mismatched filter, direct-blast origin,
coherent clutter cancellation, smallest-of CFAR — carries over unchanged, and
the test suite here is the specification for it.
