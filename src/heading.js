// Device orientation -> bearing.
//
// A single speaker/mic pair measures distance and nothing else; it has no idea
// which direction an echo came from. The trick that makes a radar display
// honest is to let the *user* be the scanning mechanism: read the iPad's
// attitude, paint each ping at the bearing the device was pointing when it
// fired, and a slow turn on the spot paints the room.

const DEG = Math.PI / 180;

/**
 * Rotation matrix taking device coordinates to world coordinates, per the
 * W3C DeviceOrientation spec (intrinsic Z-X'-Y'' with angles alpha, beta, gamma).
 *
 * World frame: X east, Y north, Z up.
 * Device frame: X right across the screen, Y up the screen, Z out of the glass.
 *
 * Returned as the three device axes expressed in world coordinates, which is
 * the form we actually want (they're the columns of R).
 */
export function deviceAxes(alphaDeg, betaDeg, gammaDeg) {
  const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);

  return {
    x: [cA * cG - sA * sB * sG, cG * sA + cA * sB * sG, -cB * sG],
    y: [-cB * sA, cA * cB, sB],
    z: [cA * sG + cG * sA * sB, sA * sG - cA * cG * sB, cB * cG],
  };
}

/**
 * The screen's "up" direction, expressed in device coordinates.
 *
 * Needed because the device's physical top edge is not what the user thinks of
 * as forward. Hold an iPad flat in landscape and "away from me" is a long edge,
 * not the short one the hardware calls +Y. `screen.orientation.angle` tells us
 * how far the content has been rotated to compensate, which is exactly the
 * correction we want.
 */
export function screenUpInDevice(screenAngleDeg = 0) {
  const t = screenAngleDeg * DEG;
  return [Math.sin(t), Math.cos(t), 0];
}

/**
 * Which way is the iPad "pointing", as a compass bearing in radians
 * (0 = world north / the alpha reference, increasing clockwise like a compass).
 *
 * There are two sensible answers depending on how you're holding it:
 *
 *   Flat on your palms, screen up  -> you're pointing "up the screen".
 *   Upright, screen facing you     -> you're pointing out the back of the slab
 *                                     (device -Z).
 *
 * Rather than switching modes at some arbitrary tilt angle, we add the two
 * candidates' horizontal projections. That blends smoothly and for free,
 * because the two vectors are perpendicular: when the iPad lies flat, screen-up
 * is horizontal and the back points straight down (no horizontal component),
 * and when it stands upright the roles swap. At the 45-degree angle you
 * actually hold a tablet at, both project onto the *same* ground bearing, so
 * there is no seam to cross.
 *
 * Using screen-up rather than the device's +Y axis is what makes this work in
 * landscape. Stand an iPad upright in landscape and its physical top edge is
 * horizontal, pointing off to one side; naively blending that with the back
 * direction splits the difference and lands 45 degrees off. Screen-up in that
 * pose points at the ceiling and correctly contributes nothing.
 *
 * @param {number} screenAngleDeg screen.orientation.angle, degrees
 * @returns {{bearing: number, confidence: number, tilt: number}}
 *   confidence is the horizontal length of the pointing vector; it collapses
 *   only in poses where the two cues genuinely disagree about forward.
 */
export function pointingBearing(alphaDeg, betaDeg, gammaDeg, screenAngleDeg = 0) {
  const ax = deviceAxes(alphaDeg, betaDeg, gammaDeg);
  const su = screenUpInDevice(screenAngleDeg);

  // Rotate screen-up into world coordinates: R * su, with R's columns being
  // the device axes we already have.
  const upW = [
    ax.x[0] * su[0] + ax.y[0] * su[1],
    ax.x[1] * su[0] + ax.y[1] * su[1],
  ];
  const backW = [-ax.z[0], -ax.z[1]];

  let px = upW[0] + backW[0];
  let py = upW[1] + backW[1];
  let mag = Math.hypot(px, py);

  if (mag < 0.25) {
    // Screen-up and the back disagree about which way is forward along the
    // ground (screen-down and tipped past vertical). Trust the more horizontal.
    const mu = Math.hypot(upW[0], upW[1]);
    const mb = Math.hypot(backW[0], backW[1]);
    if (mu >= mb) { px = upW[0]; py = upW[1]; mag = mu; }
    else { px = backW[0]; py = backW[1]; mag = mb; }
  }

  return {
    bearing: Math.atan2(px, py), // atan2(east, north) -> clockwise compass bearing
    confidence: Math.min(1, mag),
    tilt: ax.z[2], // +1 screen up, 0 upright, -1 screen down
  };
}

/** Shortest signed difference between two angles, in (-pi, pi]. */
export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Wrap to [0, 2pi). */
export function wrapAngle(a) {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/**
 * Yaw rate about the true vertical, from raw gyro plus gravity.
 *
 * Used as a fallback when DeviceOrientation isn't delivering. The projection
 * onto the gravity vector is the whole trick: we don't care how the device is
 * tilted, only how fast it's turning about the world's up axis.
 *
 * @param rotationRate DeviceMotion rotationRate, deg/s about device Z, X, Y
 * @param gravity accelerationIncludingGravity, m/s^2
 * @returns rad/s, positive clockwise seen from above
 */
export function yawRateFromGyro(rotationRate, gravity) {
  if (!rotationRate || !gravity) return 0;
  // DeviceMotion names the axes by the Euler angle each one drives.
  const wx = (rotationRate.beta ?? 0) * DEG;
  const wy = (rotationRate.gamma ?? 0) * DEG;
  const wz = (rotationRate.alpha ?? 0) * DEG;

  const gx = gravity.x ?? 0, gy = gravity.y ?? 0, gz = gravity.z ?? 0;
  const gm = Math.hypot(gx, gy, gz);
  if (gm < 1e-3) return 0;

  // accelerationIncludingGravity points *up* while at rest, so this is +up.
  const dot = (wx * gx + wy * gy + wz * gz) / gm;
  return -dot; // flip so clockwise-from-above is positive, matching bearings
}

/**
 * Live heading source. Prefers DeviceOrientation (already sensor-fused and
 * drift-corrected by iOS); falls back to integrating gyro yaw if no
 * orientation events show up.
 */
export class HeadingSource {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate;
    this.bearing = 0;       // raw, radians
    this.offset = 0;        // user-set "forward"
    this.confidence = 0;
    this.tilt = 1;
    this.rate = 0;          // rad/s, smoothed
    this.mode = 'none';     // 'orientation' | 'gyro' | 'none'
    this.available = false;
    this.lastEventAt = 0;
    this.screenAngle = 0;
    this._lastBearing = null;
    this._lastTime = 0;
    this._gyroYaw = 0;
    this._bound = false;
  }

  /** True if this platform gates sensors behind an explicit permission prompt. */
  static needsPermission() {
    return (
      (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') ||
      (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function')
    );
  }

  /**
   * Ask for motion access. iOS only grants this from inside a user gesture, so
   * this must be called straight off a tap, not after an await.
   */
  static async requestPermission() {
    const results = [];
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      results.push(await DeviceOrientationEvent.requestPermission());
    }
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      results.push(await DeviceMotionEvent.requestPermission());
    }
    if (!results.length) return 'granted'; // no gate on this platform
    return results.every((r) => r === 'granted') ? 'granted' : 'denied';
  }

  /** Current screen rotation in degrees, however this browser exposes it. */
  _readScreenAngle() {
    if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    if (typeof window !== 'undefined' && typeof window.orientation === 'number') {
      return window.orientation; // older iOS
    }
    return 0;
  }

  start() {
    if (this._bound) return;
    this.screenAngle = this._readScreenAngle();
    this._onOrientation = (e) => this._handleOrientation(e);
    this._onMotion = (e) => this._handleMotion(e);
    window.addEventListener('deviceorientation', this._onOrientation, true);
    window.addEventListener('devicemotion', this._onMotion, true);
    this._bound = true;
  }

  stop() {
    if (!this._bound) return;
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
    this._bound = false;
  }

  /** Call the current direction "straight ahead". */
  zero() {
    this.offset = this.bearing;
  }

  /** Bearing relative to whatever the user called forward, in [0, 2pi). */
  get heading() {
    return wrapAngle(this.bearing - this.offset);
  }

  _handleOrientation(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;
    this.mode = 'orientation';
    this.available = true;
    this.lastEventAt = performance.now();

    this.screenAngle = this._readScreenAngle();
    const { bearing, confidence, tilt } =
      pointingBearing(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0, this.screenAngle);
    // alpha counts counter-clockwise; pointingBearing already converts to a
    // clockwise compass bearing, so there is no extra flip here.
    this._commit(bearing, confidence, tilt);
  }

  _handleMotion(e) {
    // Only integrate gyro if DeviceOrientation has gone quiet for a while.
    const stale = performance.now() - this.lastEventAt > 1500;
    if (this.mode === 'orientation' && !stale) return;

    const rate = yawRateFromGyro(e.rotationRate, e.accelerationIncludingGravity);
    if (!rate && this.mode === 'none') return;

    const dt = Math.min(0.1, (e.interval || 1 / 60));
    this._gyroYaw += rate * dt;
    this.mode = 'gyro';
    this.available = true;
    const g = e.accelerationIncludingGravity;
    const tilt = g ? (g.z ?? 0) / (Math.hypot(g.x ?? 0, g.y ?? 0, g.z ?? 0) || 1) : 0;
    this._commit(this._gyroYaw, 0.6, tilt);
  }

  _commit(bearing, confidence, tilt) {
    const now = performance.now();
    if (this._lastBearing !== null && this._lastTime) {
      const dt = (now - this._lastTime) / 1000;
      if (dt > 0.002) {
        const inst = angleDelta(bearing, this._lastBearing) / dt;
        // Light smoothing: the raw rate is jittery enough to make any UI
        // driven by it twitch.
        this.rate = this.rate * 0.8 + inst * 0.2;
      }
    }
    this._lastBearing = bearing;
    this._lastTime = now;
    this.bearing = bearing;
    this.confidence = confidence;
    this.tilt = tilt;
    this.onUpdate?.(this);
  }
}
