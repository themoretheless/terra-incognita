import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { FogStore, CHUNK_ZOOM, traceChunk } from '../../src/fog-store.js';
import { openDatabase, STORES, done } from '../../src/db.js';
import { pointInMultiPolygon } from '../../src/geo.js';

const PARIS = { lat: 48.8566, lng: 2.3522 };
const store = (factory, extra = {}) => new FogStore({ factory, storage: null, broadcast: false, ...extra });

test('reveal открывает круг, повтор ничего не добавляет', async () => {
  const fog = store(new IDBFactory());
  await fog.ready;
  await fog.ensureAround(PARIS.lat, PARIS.lng, 30);
  const first = fog.reveal(PARIS.lat, PARIS.lng, 30);
  assert.ok(first.length > 60 && first.length < 110, String(first.length));
  assert.equal(fog.reveal(PARIS.lat, PARIS.lng, 30).length, 0);
  assert.equal(fog.isRevealed(PARIS.lat, PARIS.lng), true);
  assert.equal(fog.isRevealed(PARIS.lat + 0.01, PARIS.lng), false);
  assert.equal(fog.totalCells, first.length);
});

test('данные переживают перезапуск, загрузка ленивая, индекс и агрегаты согласованы', async () => {
  const factory = new IDBFactory();
  const a = store(factory);
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  a.reveal(PARIS.lat + 0.05, PARIS.lng + 0.05, 30);
  await a.flush();
  const b = store(factory);
  await b.ready;
  assert.equal(b.totalCells, a.totalCells);
  assert.equal(b.chunks.size, 0, 'битовые карты не грузятся при старте');
  assert.equal(b.isRevealed(PARIS.lat, PARIS.lng), null, 'до загрузки ответ неизвестен');
  await b.ensureAround(PARIS.lat, PARIS.lng, 30);
  assert.equal(b.isRevealed(PARIS.lat, PARIS.lng), true);
  const sum = [...b.aggregates.levels.get(10).values()].reduce((s, v) => s + v, 0);
  assert.equal(sum, b.totalCells);
  assert.ok(b.index.get([...b.index.keys()][0]).visited > 0);
});

test('шаг рядом с незагруженным чанком не затирает данные', async () => {
  const factory = new IDBFactory();
  const a = store(factory);
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  await a.flush();
  const before = a.totalCells;
  const b = store(factory);
  await b.ready;
  await b.ensureAround(PARIS.lat, PARIS.lng + 0.0002, 30);
  b.reveal(PARIS.lat, PARIS.lng + 0.0002, 30);
  assert.ok(b.totalCells > before);
  assert.equal(b.isRevealed(PARIS.lat, PARIS.lng), true);
});

test('полный чанк хранится флагом и восстанавливается', async () => {
  const factory = new IDBFactory();
  const a = store(factory);
  await a.ready;
  const chunk = a.chunkAt(1 << 21, 1 << 21, true);
  chunk.bits.fill(0xff);
  chunk.recount();
  chunk.dirty = true;
  a.syncIndex(chunk);
  await a.flush();
  const db = await openDatabase(factory);
  const tx = db.transaction(STORES.chunks);
  const row = await new Promise((r) => {
    const q = tx.objectStore(STORES.chunks).get(chunk.key);
    q.onsuccess = () => r(q.result);
  });
  assert.equal(row.full, true);
  assert.equal(row.rle, undefined);
  db.close();
  const b = store(factory);
  await b.ready;
  await b.load([chunk.key]);
  assert.equal(b.chunks.get(chunk.key).count, 65536);
});

test('LRU вытесняет чистые незакреплённые чанки', async () => {
  const factory = new IDBFactory();
  const a = store(factory, { lruLimit: 3 });
  await a.ready;
  for (let i = 0; i < 6; i += 1) a.reveal(PARIS.lat + i * 0.05, PARIS.lng, 20);
  await a.flush();
  assert.ok(a.chunks.size <= 3, String(a.chunks.size));
  assert.equal(a.index.size, 6);
});

test('экспорт v2 с контрольной суммой, импорт union/subtract/replace и отмена', async () => {
  const a = store(new IDBFactory());
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  const text = await a.exportJSON();
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 2);
  assert.match(parsed.checksum, /^[0-9a-f]{8}$/);

  const b = store(new IDBFactory());
  await b.ready;
  b.reveal(PARIS.lat + 0.01, PARIS.lng, 30);
  const own = b.totalCells;
  await b.importJSON(text, 'union');
  assert.equal(b.totalCells, own + a.totalCells);
  await b.undoImport();
  assert.equal(b.totalCells, own);
  await b.importJSON(text, 'replace');
  assert.equal(b.totalCells, a.totalCells);
  await b.importJSON(text, 'subtract');
  assert.equal(b.totalCells, 0);

  const broken = JSON.parse(text);
  broken.checksum = '00000000';
  await assert.rejects(b.importJSON(JSON.stringify(broken)), /контрольная сумма/);
});

test('импорт экспорта v1 (сырые base64)', async () => {
  const a = store(new IDBFactory());
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  const chunk = [...a.chunks.values()][0];
  const v1 = JSON.stringify({ format: 'terra-incognita-fog', version: 1, cellZoom: 22, chunkBits: 8, chunks: { [chunk.key]: Buffer.from(chunk.bits).toString('base64') } });
  const b = store(new IDBFactory());
  await b.ready;
  await b.importJSON(v1);
  assert.equal(b.totalCells, chunk.count);
});

test('revealPath открывает коридор вдоль трека', async () => {
  const a = store(new IDBFactory());
  await a.ready;
  const added = await a.revealPath([PARIS, { lat: PARIS.lat + 0.005, lng: PARIS.lng }], 15);
  assert.ok(added > 100, String(added));
  assert.equal(a.isRevealed(PARIS.lat + 0.0025, PARIS.lng), true);
});

test('H3: экспорт и обратный импорт', async () => {
  const h3 = await import('h3-js');
  const a = store(new IDBFactory());
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  const text = await a.exportH3(h3, 12);
  const b = store(new IDBFactory());
  await b.ready;
  const result = await b.importH3(h3, text);
  assert.ok(result.cells > 0 && result.added > 0);
  assert.equal(b.isRevealed(PARIS.lat, PARIS.lng), true);
});

test('GeoJSON: контуры покрывают открытые клетки', async () => {
  const a = store(new IDBFactory());
  await a.ready;
  a.reveal(PARIS.lat, PARIS.lng, 30);
  const geo = JSON.parse(await a.exportGeoJSON());
  assert.equal(geo.type, 'FeatureCollection');
  const mp = geo.features[0].geometry.coordinates;
  assert.equal(pointInMultiPolygon(PARIS.lat, PARIS.lng, mp), true);
  assert.equal(pointInMultiPolygon(PARIS.lat + 0.001, PARIS.lng, mp), false);
  const ring = traceChunk([...a.chunks.values()][0]);
  assert.ok(ring.length >= 1);
});

test('миграции v1 → v3 и v2 → v3 сохраняют данные', async () => {
  for (const startVersion of [1, 2]) {
    const factory = new IDBFactory();
    const db = await openDatabase(factory, startVersion);
    const bits = new Uint8Array(8192);
    bits.fill(0xff, 0, 64);
    const key = `${CHUNK_ZOOM}/8299/5636`;
    const tx = db.transaction(startVersion === 1 ? [STORES.chunks] : [STORES.chunks, STORES.index], 'readwrite');
    tx.objectStore(STORES.chunks).put({ key, bits });
    if (startVersion === 2) tx.objectStore(STORES.index).put({ key, count: 512 });
    await done(tx);
    db.close();
    const fog = store(factory);
    await fog.ready;
    assert.equal(fog.totalCells, 512, `из версии ${startVersion}`);
    await fog.load([key]);
    assert.equal(fog.chunks.get(key).count, 512);
  }
});

test('ошибка открытия базы переводит на запасное хранилище', async () => {
  const broken = {
    open() {
      throw Object.assign(new Error('denied'), { name: 'SecurityError' });
    }
  };
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const fog = new FogStore({ factory: broken, storage, broadcast: false });
  await fog.ready;
  assert.equal(fog.error.code, 'unavailable');
  fog.reveal(PARIS.lat, PARIS.lng, 20);
  await fog.flush();
  const again = new FogStore({ factory: null, storage, broadcast: false });
  await again.ready;
  assert.equal(again.totalCells, fog.totalCells);
});

test('повторный open не удваивает счётчики', async () => {
  const factory = new IDBFactory();
  const a = new FogStore({ factory, storage: null, broadcast: false });
  await a.ready;
  a.reveal(48.8566, 2.3522, 20);
  await a.flush();
  const b = new FogStore({ factory, storage: null, broadcast: false });
  await b.ready;
  await b.open(factory);
  await b.loadAll();
  assert.equal(b.totalCells, a.totalCells);
});
