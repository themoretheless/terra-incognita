// Бенчмарк хранилища: 10⁵ клеток в 10³ чанках на fake-indexeddb.
import { IDBFactory } from 'fake-indexeddb';
import { FogStore, CHUNK_SIZE } from '../src/fog-store.js';
import { unproject } from '../src/geo.js';

const time = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(34)} ${(performance.now() - t0).toFixed(1).padStart(8)} мс`);
  return r;
};

const factory = new IDBFactory();
const store = new FogStore({ factory, storage: null, broadcast: false, lruLimit: 2048 });
await store.ready;

// 1000 чанков сеткой 40×25, по 100 точечных открытий радиусом ~3 м в каждом.
const base = { x: 8300, y: 5630 }; // чанки z14 у Парижа
await time('reveal 10⁵ клеток / 10³ чанков', () => {
  for (let c = 0; c < 1000; c += 1) {
    const cx = base.x + (c % 40);
    const cy = base.y + Math.floor(c / 40);
    for (let k = 0; k < 100; k += 1) {
      const px = cx * CHUNK_SIZE + ((k * 37) % CHUNK_SIZE) + 0.5;
      const py = cy * CHUNK_SIZE + ((k * 91) % CHUNK_SIZE) + 0.5;
      const { lat, lng } = unproject(px, py, 22);
      store.reveal(lat, lng, 2);
    }
  }
});
console.log(`  клеток: ${store.totalCells}, чанков: ${store.chunks.size}`);
await time('flush в IndexedDB', () => store.flush());

let fresh;
await time('open + загрузка индекса', () => (fresh = new FogStore({ factory, storage: null, broadcast: false })).ready);
await time('loadAll (все чанки)', () => fresh.loadAll());
console.log(`  клеток после загрузки: ${fresh.totalCells}`);
const json = await time('exportJSON', () => fresh.exportJSON());
console.log(`  размер экспорта: ${(json.length / 1024).toFixed(0)} КБ`);
const copy = new FogStore({ factory: null, storage: null, broadcast: false, lruLimit: 4096 });
await time('importJSON', () => copy.importJSON(json, 'union'));
