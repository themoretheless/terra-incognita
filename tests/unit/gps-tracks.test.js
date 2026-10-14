import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterFix, radiusForSpeed, DEFAULT_FILTERS } from '../../src/gps.js';
import { parseGPX, parseKML, parseGeoJSON, parseTrackFile, toGPX } from '../../src/tracks.js';
import { levelFor, Game } from '../../src/game.js';
import { encodeRLE, decodeRLE } from '../../src/codec.js';

const fix = (lat, lng, t, acc = 5) => ({ lat, lng, t, acc });

test('GPS: фильтры точности, скачков и стояния', () => {
  assert.equal(filterFix(null, fix(48, 2, 0, 80)).reason, 'accuracy');
  const first = filterFix(null, fix(48, 2, 0)).fix;
  assert.ok(first);
  assert.equal(filterFix(first, fix(48.1, 2, 1000)).reason, 'jump');
  assert.equal(filterFix(first, fix(48.00001, 2, 1000)).reason, 'still');
  const ok = filterFix(first, fix(48.0002, 2, 10000));
  assert.equal(ok.accept, true);
  assert.ok(ok.fix.speed > 2 && ok.fix.speed < 3);
  assert.ok(DEFAULT_FILTERS.maxAccuracy === 50);
});

test('GPS: радиус по скорости', () => {
  const r = { walk: 30, bike: 20, car: 10 };
  assert.equal(radiusForSpeed(1.4, r), 30);
  assert.equal(radiusForSpeed(5, r), 20);
  assert.equal(radiusForSpeed(15, r), 10);
});

test('GPX: разбор и обратная сборка', () => {
  const gpx = toGPX(
    [
      [
        { lat: 48.1, lng: 2.1, t: Date.parse('2026-01-01T10:00:00Z') },
        { lat: 48.2, lng: 2.2, t: 0 }
      ]
    ],
    'A & B'
  );
  assert.match(gpx, /A &amp; B/);
  const parsed = parseGPX(gpx);
  assert.equal(parsed.segments.length, 1);
  assert.deepEqual(
    parsed.segments[0].map((p) => [p.lat, p.lng]),
    [
      [48.1, 2.1],
      [48.2, 2.2]
    ]
  );
  assert.equal(parseTrackFile('x.gpx', gpx).kind, 'gpx');
});

test('KML и GeoJSON', () => {
  const kml = '<kml><Placemark><LineString><coordinates>2.1,48.1,0 2.2,48.2,0</coordinates></LineString></Placemark></kml>';
  assert.equal(parseKML(kml).segments[0].length, 2);
  const gj = parseGeoJSON({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [2.1, 48.1],
            [2.2, 48.2]
          ]
        }
      }
    ]
  });
  assert.equal(gj.segments[0][1].lat, 48.2);
});

test('уровни и опыт', () => {
  assert.deepEqual(levelFor(0), { level: 1, current: 0, next: 100 });
  assert.equal(levelFor(400).level, 3);
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const g = new Game(/** @type {any} */ (storage));
  g.recordReveal(150, Date.parse('2026-01-01T12:00:00'));
  assert.equal(g.state.xp, 150);
  assert.ok(g.checkAchievements({ area: 20000, chunks: 1, coverage: 0 }).some((a) => a.id === 'hectare'));
});

test('RLE: пустые, полные и смешанные чанки', () => {
  for (const bits of [new Uint8Array(8192), new Uint8Array(8192).fill(255), Uint8Array.from({ length: 8192 }, (_, i) => (i * 7) & 255)]) {
    assert.deepEqual(decodeRLE(encodeRLE(bits), 8192), bits);
  }
  assert.ok(encodeRLE(new Uint8Array(8192)).length < 8);
});
