import test from 'node:test';
import assert from 'node:assert/strict';
import { castRay } from '../src/simulator.js';

const room = { width: 5, height: 4, x: 2.5, y: 2, boxes: [] };
const deg = (d) => (d * Math.PI) / 180;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, want ${b}`);

test('rays reach the walls of an empty room', () => {
  close(castRay(room, 2.5, 2, deg(0), 20), 2.0, 'ahead');
  close(castRay(room, 2.5, 2, deg(90), 20), 2.5, 'right');
  close(castRay(room, 2.5, 2, deg(180), 20), 2.0, 'behind');
  close(castRay(room, 2.5, 2, deg(270), 20), 2.5, 'left');
});

test('a corner is further than either wall', () => {
  const corner = castRay(room, 2.5, 2, deg(45), 20);
  assert.ok(corner > 2.5 && corner < 3.3, `corner distance ${corner}`);
  close(corner, Math.hypot(2, 2), 'exact corner along the diagonal');
});

test('an obstacle shadows the wall behind it', () => {
  const withBox = {
    ...room,
    boxes: [{ x: 2.3, y: 3.0, w: 0.4, h: 0.4 }], // directly ahead
  };
  close(castRay(withBox, 2.5, 2, deg(0), 20), 1.0, 'stops at the box, not the wall');
  // A ray that misses it still reaches the wall.
  close(castRay(withBox, 2.5, 2, deg(90), 20), 2.5, 'unobstructed');
});

test('rays are clamped to the requested maximum', () => {
  assert.equal(castRay(room, 2.5, 2, deg(0), 1.2), 1.2);
});

test('an off-centre listener measures asymmetric distances', () => {
  close(castRay(room, 1.0, 2, deg(90), 20), 4.0, 'far wall to the right');
  close(castRay(room, 1.0, 2, deg(270), 20), 1.0, 'near wall to the left');
});
