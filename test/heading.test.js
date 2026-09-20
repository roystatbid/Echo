import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceAxes, pointingBearing, screenUpInDevice, angleDelta, wrapAngle, yawRateFromGyro } from '../src/heading.js';

const DEG = Math.PI / 180;
const toDeg = (r) => (wrapAngle(r) / DEG);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg}: expected ~${b}, got ${a}`);

test('reference pose maps device axes onto world axes', () => {
  // alpha=beta=gamma=0: flat on a table, screen up, top edge pointing north.
  const ax = deviceAxes(0, 0, 0);
  close(ax.x[0], 1, 1e-9, 'device X is east');
  close(ax.y[1], 1, 1e-9, 'device Y is north');
  close(ax.z[2], 1, 1e-9, 'device Z is up');
});

test('rotation matrix stays orthonormal across poses', () => {
  for (const [a, b, g] of [[37, 12, -80], [190, -45, 20], [0, 90, 0], [275, 60, 170]]) {
    const ax = deviceAxes(a, b, g);
    for (const v of [ax.x, ax.y, ax.z]) {
      close(Math.hypot(v[0], v[1], v[2]), 1, 1e-9, `unit length at ${a},${b},${g}`);
    }
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    close(dot(ax.x, ax.y), 0, 1e-9, 'X.Y');
    close(dot(ax.y, ax.z), 0, 1e-9, 'Y.Z');
    close(dot(ax.x, ax.z), 0, 1e-9, 'X.Z');
  }
});

test('flat on the table: bearing follows the top edge', () => {
  // alpha counts anticlockwise (right-hand rule about "up"), while compass
  // bearings run clockwise, so a bearing is 360 - alpha.
  close(toDeg(pointingBearing(0, 0, 0).bearing), 0, 0.01, 'alpha=0 -> north');
  close(toDeg(pointingBearing(90, 0, 0).bearing), 270, 0.01, 'alpha=90 -> west');
  close(toDeg(pointingBearing(180, 0, 0).bearing), 180, 0.01, 'alpha=180 -> south');
  close(toDeg(pointingBearing(270, 0, 0).bearing), 90, 0.01, 'alpha=270 -> east');
});

test('held upright: bearing follows the back of the slab', () => {
  // beta=90 stands the iPad up with the screen facing you; "forward" is now
  // out the back, not up the screen (which points at the ceiling).
  const p = pointingBearing(0, 90, 0);
  close(toDeg(p.bearing), 0, 0.01, 'upright, alpha=0 -> north');
  close(p.tilt, 0, 1e-9, 'screen normal is horizontal');
  close(toDeg(pointingBearing(90, 90, 0).bearing), 270, 0.01, 'upright, alpha=90 -> west');
});

test('the flat and upright cues agree at intermediate tilts', () => {
  // This is what makes the blend seamless: at a normal tablet-holding angle
  // both "top edge" and "out the back" project onto the same ground bearing.
  for (const beta of [15, 30, 45, 60, 75]) {
    for (const alpha of [0, 45, 137, 300]) {
      const p = pointingBearing(alpha, beta, 0);
      close(toDeg(p.bearing), wrapAngle(-alpha * DEG) / DEG, 0.01, `alpha=${alpha} beta=${beta}`);
      assert.ok(p.confidence > 0.5, `confidence at beta=${beta}: ${p.confidence}`);
    }
  }
});

test('bearing is continuous as the device tips from flat to upright', () => {
  let prev = pointingBearing(120, 0, 0).bearing;
  for (let beta = 1; beta <= 95; beta++) {
    const cur = pointingBearing(120, beta, 0).bearing;
    assert.ok(Math.abs(angleDelta(cur, prev)) < 2 * DEG,
      `jump of ${(angleDelta(cur, prev) / DEG).toFixed(2)} deg at beta=${beta}`);
    prev = cur;
  }
});

test('tilt reports which way the screen faces', () => {
  close(pointingBearing(0, 0, 0).tilt, 1, 1e-9, 'flat, screen up');
  close(pointingBearing(0, 180, 0).tilt, -1, 1e-9, 'flat, screen down');
});

test('screen-up follows the screen rotation', () => {
  const eq = (got, want, msg) => {
    for (let i = 0; i < 3; i++) close(got[i], want[i], 1e-9, `${msg}[${i}]`);
  };
  eq(screenUpInDevice(0), [0, 1, 0], 'portrait: up the short edge');
  eq(screenUpInDevice(90), [1, 0, 0], 'landscape: up is the device +X edge');
  eq(screenUpInDevice(180), [0, -1, 0], 'upside down');
  eq(screenUpInDevice(270), [-1, 0, 0], 'the other landscape');
});

test('turning the iPad to landscape does not swing the bearing', () => {
  // This is the case that a naive "use the physical top edge" rule gets wrong.
  // Both poses below have the back of the device facing north; the second is
  // just the first rolled into landscape, with iOS rotating the content to
  // compensate (screen.orientation.angle = 90).
  const portrait = pointingBearing(0, 90, 0, 0);
  const landscape = pointingBearing(90, 0, -90, 90);

  // Confirm the two poses really do aim the same way before comparing.
  for (const [a, b, g] of [[0, 90, 0], [90, 0, -90]]) {
    const ax = deviceAxes(a, b, g);
    close(-ax.z[0], 0, 1e-6, `back is due north (east cmp) at ${a},${b},${g}`);
    close(-ax.z[1], 1, 1e-6, `back is due north (north cmp) at ${a},${b},${g}`);
  }

  close(toDeg(portrait.bearing), 0, 0.01, 'portrait upright -> north');
  close(toDeg(landscape.bearing), 0, 0.01, 'landscape upright -> north');
  assert.ok(landscape.confidence > 0.5, `landscape confidence ${landscape.confidence}`);

  // Without the screen-orientation correction this pose reads 45 degrees off,
  // because the physical top edge is horizontal and points west.
  const naive = pointingBearing(90, 0, -90, 0);
  assert.ok(Math.abs(angleDelta(naive.bearing, landscape.bearing)) > 30 * DEG,
    'the screen-angle correction should be doing real work here');
});

test('flat in landscape points along the long edge', () => {
  // Flat, screen up, held in landscape: forward is a long edge, and it must
  // still track alpha the same way portrait does.
  const flatPortrait = pointingBearing(0, 0, 0, 0);
  const flatLandscape = pointingBearing(0, 0, 0, 90);
  close(toDeg(flatPortrait.bearing), 0, 0.01, 'portrait flat -> north');
  close(toDeg(flatLandscape.bearing), 90, 0.01, 'landscape flat -> east (device +X)');
  assert.ok(flatLandscape.confidence > 0.9, 'and confidently so');
});

test('angleDelta takes the short way round', () => {
  close(angleDelta(0.1, 2 * Math.PI - 0.1), 0.2, 1e-9, 'across the wrap');
  close(angleDelta(Math.PI / 2, 0), Math.PI / 2, 1e-9, 'plain');
  close(angleDelta(0, Math.PI / 2), -Math.PI / 2, 1e-9, 'negative');
});

test('gyro yaw rate projects onto true vertical regardless of tilt', () => {
  // Device flat, screen up: gravity along +Z, so a spin about device Z is a
  // pure yaw.
  const flat = { x: 0, y: 0, z: 9.81 };
  close(yawRateFromGyro({ alpha: 90, beta: 0, gamma: 0 }, flat), -90 * DEG, 1e-9, 'flat yaw');

  // Device upright: gravity now lies along +Y, so the same world yaw shows up
  // on the *gamma* axis instead. The projection should give the same answer.
  const upright = { x: 0, y: 9.81, z: 0 };
  close(yawRateFromGyro({ alpha: 0, beta: 0, gamma: 90 }, upright), -90 * DEG, 1e-9, 'upright yaw');

  // Tipping the device (rotation about the horizontal axis) is not yaw at all.
  close(yawRateFromGyro({ alpha: 0, beta: 90, gamma: 0 }, flat), 0, 1e-9, 'pitch is not yaw');
});

test('wrapAngle normalises into [0, 2pi)', () => {
  close(wrapAngle(-0.5), 2 * Math.PI - 0.5, 1e-9, 'negative');
  close(wrapAngle(7), 7 - 2 * Math.PI, 1e-9, 'over one turn');
  close(wrapAngle(0), 0, 1e-9, 'zero');
});
