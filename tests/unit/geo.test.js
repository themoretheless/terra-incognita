import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, unproject, distance, bearing, densify, pointInPolygon, multiPolygonArea, sunTimes, metersPerTile } from '../../src/geo.js';

test('project/unproject обратимы', () => {
  const p = project(48.8566, 2.3522, 22);
  const back = unproject(p.x, p.y, 22);
  assert.ok(Math.abs(back.lat - 48.8566) < 1e-9);
  assert.ok(Math.abs(back.lng - 2.3522) < 1e-9);
});

test('расстояние Париж–Лондон ≈ 344 км, азимут на северо-запад', () => {
  const d = distance(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(Math.abs(d - 343500) < 2000, String(d));
  const b = bearing(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(b > 320 && b < 340, String(b));
});

test('densify даёт шаг не больше заданного', () => {
  const pts = densify(
    [
      { lat: 48.85, lng: 2.35 },
      { lat: 48.86, lng: 2.35 }
    ],
    50
  );
  for (let i = 1; i < pts.length; i += 1) {
    assert.ok(distance(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng) <= 50.01);
  }
});

test('полигон с дырой и площадь', () => {
  const outer = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
    [0, 0]
  ];
  const hole = [
    [0.004, 0.004],
    [0.006, 0.004],
    [0.006, 0.006],
    [0.004, 0.006],
    [0.004, 0.004]
  ];
  assert.equal(pointInPolygon(0.002, 0.002, [outer, hole]), true);
  assert.equal(pointInPolygon(0.005, 0.005, [outer, hole]), false);
  const area = multiPolygonArea([[outer]]);
  const side = (metersPerTile(0, 0) / 360) * 0.01;
  assert.ok(Math.abs(area - side * side) / area < 0.01, String(area));
});

test('восход в Париже 21 июня около 03:47 UTC', () => {
  const t = sunTimes(new Date(Date.UTC(2026, 5, 21)), 48.8566, 2.3522);
  assert.ok(t);
  const h = new Date(t.sunrise).getUTCHours() + new Date(t.sunrise).getUTCMinutes() / 60;
  assert.ok(Math.abs(h - 3.78) < 0.25, String(h));
});
