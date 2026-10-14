// @ts-check
/**
 * Хранилище открытых областей.
 *
 * Мир нарезан на клетки тайловой сетки Web Mercator на зуме CELL_ZOOM (22):
 * у экватора клетка ≈ 9.6 м, в Париже ≈ 6.3 м. Клетки собраны в чанки 256×256
 * (тайлы зума 14, ≈ 2.4 км). Чанк в памяти — битовая карта на 8 КБ.
 *
 * На диске (IndexedDB, см. db.js):
 *   chunks       {key, rle | full, heat?}   — RLE-сжатая карта или флаг «полностью открыт»
 *   chunk-index  {key, count, visited, full} — лёгкий индекс, читается целиком при старте
 * Битовые карты подгружаются лениво: для видимой области и вокруг путешественника.
 * Из памяти вытесняются по LRU. Запись отложенная, с повтором при ошибке.
 * Изменения рассылаются другим вкладкам через BroadcastChannel.
 */
import { project, unproject, metersPerTile, densify, pointInRing } from './geo.js';
import { encodeRLE, decodeRLE, bytesToBase64, base64ToBytes, fnv1a, popcount, POPCOUNT } from './codec.js';
import { openDatabase, STORES, CHUNK_BYTES, CHUNK_CELLS, promisify, done, describeStorageError, StorageError } from './db.js';

export const CELL_ZOOM = 22;
export const CHUNK_BITS = 8;
export const CHUNK_SIZE = 1 << CHUNK_BITS;
export const CHUNK_ZOOM = CELL_ZOOM - CHUNK_BITS;
export const HEAT_SIZE = 64; // тепловая карта: 64×64 на чанк (блок 4×4 клетки)
const HEAT_SHIFT = CHUNK_BITS - 6;
export const AGG_ZOOMS = [10, 11, 12, 13]; // пирамида агрегатов над чанками z14
const SAVE_DELAY = 800;
const LS_KEY = 'terra-fog-chunks';
const CHANNEL = 'terra-fog';
const DEFAULT_LRU_LIMIT = 256;

/**
 * @typedef {import('./geo.js').Bounds} Bounds
 * @typedef {import('./geo.js').LatLng} LatLng
 * @typedef {{ count: number, visited: number, full: boolean }} IndexEntry
 * @typedef {{ chunk: Chunk, index: number }} AddedCell
 * @typedef {'union' | 'replace' | 'subtract'} ImportMode
 */

export function chunkKey(/** @type {number} */ cx, /** @type {number} */ cy) {
  return `${CHUNK_ZOOM}/${cx}/${cy}`;
}

/** @param {string} key */
export function parseChunkKey(key) {
  const [, x, y] = key.split('/').map(Number);
  return { cx: x, cy: y };
}

export class Chunk {
  /**
   * @param {string} key
   * @param {Uint8Array} [bits]
   * @param {Uint8Array} [heat]
   */
  constructor(key, bits, heat) {
    const { cx, cy } = parseChunkKey(key);
    this.key = key;
    this.cx = cx;
    this.cy = cy;
    this.bits = bits || new Uint8Array(CHUNK_BYTES);
    /** то, что уже отрисовано (без идущей анимации проявления) */
    this.shown = this.bits.slice();
    this.count = popcount(this.bits);
    this.heat = heat || new Uint8Array(HEAT_SIZE * HEAT_SIZE);
    this.visited = 0;
    this.dirty = false;
    /** растёт при каждом изменении shown — по нему рендерер сбрасывает кэш картинок */
    this.version = 1;
    /** растёт при изменении тепловой карты */
    this.heatVersion = 1;
  }

  /** @param {number} lx @param {number} ly */
  static index(lx, ly) {
    return (ly << CHUNK_BITS) | lx;
  }

  /** @param {number} lx @param {number} ly */
  has(lx, ly) {
    const i = Chunk.index(lx, ly);
    return (this.bits[i >> 3] >> (i & 7)) & 1;
  }

  /** @param {number} lx @param {number} ly */
  set(lx, ly) {
    const i = Chunk.index(lx, ly);
    const mask = 1 << (i & 7);
    if (this.bits[i >> 3] & mask) return false;
    this.bits[i >> 3] |= mask;
    this.count += 1;
    this.dirty = true;
    return true;
  }

  /** @param {number} lx @param {number} ly */
  unset(lx, ly) {
    const i = Chunk.index(lx, ly);
    const mask = 1 << (i & 7);
    if (!(this.bits[i >> 3] & mask)) return false;
    this.bits[i >> 3] &= ~mask;
    this.shown[i >> 3] &= ~mask;
    this.count -= 1;
    this.dirty = true;
    this.version += 1;
    return true;
  }

  /** @param {number} i */
  show(i) {
    const mask = 1 << (i & 7);
    if (this.shown[i >> 3] & mask) return;
    this.shown[i >> 3] |= mask;
    this.version += 1;
  }

  showAll() {
    this.shown.set(this.bits);
    this.version += 1;
  }

  recount() {
    this.count = popcount(this.bits);
  }

  /** Отметка посещения в тепловой карте. @param {number} lx @param {number} ly */
  heatUp(lx, ly) {
    const i = (ly >> HEAT_SHIFT) * HEAT_SIZE + (lx >> HEAT_SHIFT);
    if (this.heat[i] < 255) {
      this.heat[i] += 1;
      this.heatVersion += 1;
      this.dirty = true;
    }
  }
}

/**
 * Простой агрегат над индексом: счётчики открытых клеток на зумах 10..13.
 */
class Aggregates {
  constructor() {
    /** @type {Map<number, Map<string, number>>} */
    this.levels = new Map(AGG_ZOOMS.map((z) => [z, new Map()]));
  }

  /** @param {string} key @param {number} delta */
  add(key, delta) {
    if (!delta) return;
    const { cx, cy } = parseChunkKey(key);
    AGG_ZOOMS.forEach((z) => {
      const shift = CHUNK_ZOOM - z;
      const k = `${z}/${cx >> shift}/${cy >> shift}`;
      const level = /** @type {Map<string, number>} */ (this.levels.get(z));
      level.set(k, (level.get(k) || 0) + delta);
    });
  }

  clear() {
    this.levels.forEach((level) => level.clear());
  }

  /** @param {number} z @param {number} x @param {number} y */
  get(z, x, y) {
    const level = this.levels.get(z);
    return level ? level.get(`${z}/${x}/${y}`) || 0 : 0;
  }
}

export class FogStore {
  /**
   * @param {{ factory?: IDBFactory | null, storage?: Storage | null, broadcast?: boolean, lruLimit?: number }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, Chunk>} загруженные чанки, порядок вставки = LRU */
    this.chunks = new Map();
    /** @type {Map<string, IndexEntry>} все чанки в хранилище */
    this.index = new Map();
    /** @type {Map<string, Promise<number>>} */
    this.loading = new Map();
    this.aggregates = new Aggregates();
    this.totalCells = 0;
    this.lruLimit = options.lruLimit || DEFAULT_LRU_LIMIT;
    /** @type {Set<string>} чанки, которые нельзя вытеснять (видимые сейчас) */
    this.pinned = new Set();
    /** @type {IDBDatabase | null} */
    this.db = null;
    /** @type {Storage | null} */
    this.storage = options.storage === undefined ? globalThis.localStorage || null : options.storage;
    /** @type {StorageError | null} */
    this.error = null;
    this.saveTimer = /** @type {any} */ (null);
    /** @type {null | { touched: Map<string, Uint8Array | null>, mode: ImportMode }} */
    this.undoSnapshot = null;
    /** @type {Record<string, Array<(payload: any) => void>>} */
    this.listeners = {};
    /** @type {BroadcastChannel | null} */
    this.channel = null;
    if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event) => this.onBroadcast(event.data);
    }
    this.ready = this.open(options.factory === undefined ? globalThis.indexedDB : options.factory);
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush());
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.flush();
      });
    }
  }

  // ---------- события ----------

  /** @param {string} name @param {(payload: any) => void} fn */
  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
    return () => {
      this.listeners[name] = this.listeners[name].filter((f) => f !== fn);
    };
  }

  /** @param {string} name @param {any} [payload] */
  emit(name, payload) {
    (this.listeners[name] || []).forEach((fn) => fn(payload));
  }

  // ---------- геометрия ----------

  /** @param {number} lat @param {number} lng */
  cellOf(lat, lng) {
    const p = project(lat, lng, CELL_ZOOM);
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  /** @param {number} lat */
  metersPerCell(lat) {
    return metersPerTile(lat, CELL_ZOOM);
  }

  /** @param {{cx: number, cy: number}} chunk @returns {Bounds} */
  chunkBounds(chunk) {
    const nw = unproject(chunk.cx, chunk.cy, CHUNK_ZOOM);
    const se = unproject(chunk.cx + 1, chunk.cy + 1, CHUNK_ZOOM);
    return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
  }

  /**
   * @param {number} cellX @param {number} cellY @param {boolean} create
   * @returns {Chunk | undefined}
   */
  chunkAt(cellX, cellY, create) {
    const key = chunkKey(cellX >> CHUNK_BITS, cellY >> CHUNK_BITS);
    let chunk = this.chunks.get(key);
    if (!chunk && create) {
      chunk = new Chunk(key);
      this.chunks.set(key, chunk);
    }
    if (chunk) this.touch(chunk);
    return chunk;
  }

  /**
   * Открыта ли клетка. null — чанк есть на диске, но ещё не загружен.
   * @param {number} lat @param {number} lng
   * @returns {boolean | null}
   */
  isRevealed(lat, lng) {
    const c = this.cellOf(lat, lng);
    return this.isCellRevealed(c.x, c.y);
  }

  /** @param {number} x @param {number} y @returns {boolean | null} */
  isCellRevealed(x, y) {
    const key = chunkKey(x >> CHUNK_BITS, y >> CHUNK_BITS);
    const chunk = this.chunks.get(key);
    if (chunk) return Boolean(chunk.has(x & (CHUNK_SIZE - 1), y & (CHUNK_SIZE - 1)));
    const entry = this.index.get(key);
    if (!entry || !entry.count) return false;
    if (entry.full) return true;
    return null;
  }

  // ---------- открытие ----------

  /**
   * Открывает круг радиусом radiusMeters. Чанки вокруг должны быть загружены (ensureAround).
   * @param {number} lat @param {number} lng @param {number} radiusMeters
   * @param {number} [now]
   * @returns {AddedCell[]}
   */
  reveal(lat, lng, radiusMeters, now = Date.now()) {
    const center = project(lat, lng, CELL_ZOOM);
    const r = Math.max(0.5, radiusMeters / this.metersPerCell(lat));
    /** @type {AddedCell[]} */
    const added = [];
    /** @type {Set<Chunk>} */
    const touched = new Set();
    const minY = Math.floor(center.y - r);
    const maxY = Math.floor(center.y + r);
    for (let cy = minY; cy <= maxY; cy += 1) {
      const dy = cy + 0.5 - center.y;
      const half = Math.sqrt(Math.max(0, r * r - dy * dy));
      const minX = Math.floor(center.x - half);
      const maxX = Math.floor(center.x + half);
      for (let cx = minX; cx <= maxX; cx += 1) {
        const chunk = /** @type {Chunk} */ (this.chunkAt(cx, cy, true));
        touched.add(chunk);
        if (chunk.set(cx & (CHUNK_SIZE - 1), cy & (CHUNK_SIZE - 1))) {
          added.push({ chunk, index: Chunk.index(cx & (CHUNK_SIZE - 1), cy & (CHUNK_SIZE - 1)) });
        }
      }
    }
    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const own = this.chunkAt(cx, cy, true);
    if (own) own.heatUp(cx & (CHUNK_SIZE - 1), cy & (CHUNK_SIZE - 1));
    touched.forEach((chunk) => {
      chunk.visited = now;
      chunk.dirty = true;
      this.syncIndex(chunk);
    });
    this.scheduleSave();
    if (added.length) this.emit('reveal', { added: added.length, lat, lng, now });
    return added;
  }

  /**
   * Открывает коридор вдоль ломаной.
   * @param {LatLng[]} points @param {number} radiusMeters @param {number} [now]
   */
  async revealPath(points, radiusMeters, now = Date.now()) {
    const dense = densify(points, Math.max(1, radiusMeters / 2));
    let added = 0;
    for (let i = 0; i < dense.length; i += 64) {
      const part = dense.slice(i, i + 64);
      await this.ensureBounds(boundsOf(part, radiusMeters));
      part.forEach((p) => {
        added += this.reveal(p.lat, p.lng, radiusMeters, now).length;
      });
    }
    return added;
  }

  /**
   * Открывает клетки, чьи центры внутри кольца [lng, lat].
   * @param {Array<[number, number]>} ring @param {number} [now]
   */
  async revealRing(ring, now = Date.now()) {
    let north = -90;
    let south = 90;
    let west = 180;
    let east = -180;
    ring.forEach(([lng, lat]) => {
      north = Math.max(north, lat);
      south = Math.min(south, lat);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
    });
    await this.ensureBounds({ north, south, west, east });
    const nw = project(north, west, CELL_ZOOM);
    const se = project(south, east, CELL_ZOOM);
    let added = 0;
    /** @type {Set<Chunk>} */
    const touched = new Set();
    for (let y = Math.floor(nw.y); y <= Math.floor(se.y); y += 1) {
      for (let x = Math.floor(nw.x); x <= Math.floor(se.x); x += 1) {
        const c = unproject(x + 0.5, y + 0.5, CELL_ZOOM);
        if (!pointInRing(c.lat, c.lng, ring)) continue;
        const chunk = /** @type {Chunk} */ (this.chunkAt(x, y, true));
        touched.add(chunk);
        if (chunk.set(x & (CHUNK_SIZE - 1), y & (CHUNK_SIZE - 1))) added += 1;
      }
    }
    touched.forEach((chunk) => {
      chunk.visited = Math.max(chunk.visited, now);
      chunk.showAll();
      this.syncIndex(chunk);
    });
    this.scheduleSave();
    if (added) this.emit('reveal', { added, now });
    return added;
  }

  /** Обновляет индекс, агрегаты и totalCells по чанку. @param {Chunk} chunk */
  syncIndex(chunk) {
    const prev = this.index.get(chunk.key);
    const delta = chunk.count - (prev ? prev.count : 0);
    this.totalCells += delta;
    this.aggregates.add(chunk.key, delta);
    this.index.set(chunk.key, { count: chunk.count, visited: chunk.visited, full: chunk.count === CHUNK_CELLS });
  }

  /** @param {number} lat */
  revealedArea(lat) {
    const m = this.metersPerCell(lat);
    return this.totalCells * m * m;
  }

  // ---------- выборки ----------

  /** @param {Bounds} bounds */
  keysInBounds(bounds) {
    const nw = project(bounds.north, bounds.west, CHUNK_ZOOM);
    const se = project(bounds.south, bounds.east, CHUNK_ZOOM);
    const x0 = Math.floor(nw.x);
    const x1 = Math.floor(se.x);
    const y0 = Math.floor(nw.y);
    const y1 = Math.floor(se.y);
    /** @type {string[]} */
    const out = [];
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= this.index.size) {
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const key = chunkKey(x, y);
          const entry = this.index.get(key);
          if (entry && entry.count) out.push(key);
        }
      }
    } else {
      this.index.forEach((entry, key) => {
        if (!entry.count) return;
        const { cx, cy } = parseChunkKey(key);
        if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) out.push(key);
      });
    }
    return out;
  }

  /**
   * Загруженные чанки в прямоугольнике; недостающие подгружаются, по готовности — событие 'loaded'.
   * Видимые чанки закрепляются от вытеснения.
   * @param {Bounds} bounds
   */
  chunksInBounds(bounds) {
    const keys = this.keysInBounds(bounds);
    /** @type {Chunk[]} */
    const out = [];
    /** @type {string[]} */
    const missing = [];
    this.pinned = new Set(keys);
    keys.forEach((key) => {
      const chunk = this.chunks.get(key);
      if (chunk) {
        if (chunk.count) out.push(chunk);
      } else missing.push(key);
    });
    if (missing.length) {
      this.load(missing).then((loaded) => {
        if (loaded) this.emit('loaded', { keys: missing });
      });
    }
    return out;
  }

  /** @param {Bounds} bounds */
  ensureBounds(bounds) {
    return this.load(this.keysInBounds(bounds).filter((key) => !this.chunks.has(key)));
  }

  /** @param {number} lat @param {number} lng @param {number} radiusMeters */
  ensureAround(lat, lng, radiusMeters) {
    return this.ensureBounds(boundsOf([{ lat, lng }], radiusMeters));
  }

  /**
   * Обход открытых клеток в прямоугольнике (сначала догружает чанки).
   * @param {Bounds} bounds @param {(x: number, y: number) => void} fn
   */
  async forEachCellIn(bounds, fn) {
    await this.ensureBounds(bounds);
    const nw = project(bounds.north, bounds.west, CELL_ZOOM);
    const se = project(bounds.south, bounds.east, CELL_ZOOM);
    this.keysInBounds(bounds).forEach((key) => {
      const chunk = this.chunks.get(key);
      if (!chunk) return;
      const baseX = chunk.cx << CHUNK_BITS;
      const baseY = chunk.cy << CHUNK_BITS;
      for (let i = 0; i < chunk.bits.length; i += 1) {
        const byte = chunk.bits[i];
        if (!byte) continue;
        for (let b = 0; b < 8; b += 1) {
          if (!(byte & (1 << b))) continue;
          const idx = (i << 3) | b;
          const x = baseX + (idx & (CHUNK_SIZE - 1));
          const y = baseY + (idx >> CHUNK_BITS);
          if (x >= nw.x - 1 && x <= se.x && y >= nw.y - 1 && y <= se.y) fn(x, y);
        }
      }
    });
  }

  /** Перебор всех открытых клеток: центр каждой. @param {(lat: number, lng: number) => void} fn */
  forEachCell(fn) {
    this.chunks.forEach((chunk) => {
      const baseX = chunk.cx << CHUNK_BITS;
      const baseY = chunk.cy << CHUNK_BITS;
      for (let i = 0; i < chunk.bits.length; i += 1) {
        const byte = chunk.bits[i];
        if (!byte) continue;
        for (let b = 0; b < 8; b += 1) {
          if (!(byte & (1 << b))) continue;
          const idx = (i << 3) | b;
          const p = unproject(baseX + (idx & (CHUNK_SIZE - 1)) + 0.5, baseY + (idx >> CHUNK_BITS) + 0.5, CELL_ZOOM);
          fn(p.lat, p.lng);
        }
      }
    });
  }

  // ---------- LRU ----------

  /** @param {Chunk} chunk */
  touch(chunk) {
    this.chunks.delete(chunk.key);
    this.chunks.set(chunk.key, chunk);
  }

  /** Вытесняет чистые незакреплённые чанки сверх лимита. */
  evict() {
    if (this.chunks.size <= this.lruLimit) return 0;
    let evicted = 0;
    for (const [key, chunk] of this.chunks) {
      if (this.chunks.size <= this.lruLimit) break;
      if (chunk.dirty || this.pinned.has(key) || !this.index.has(key)) continue;
      this.chunks.delete(key);
      this.emit('evict', chunk);
      evicted += 1;
    }
    return evicted;
  }

  // ---------- хранение ----------

  /** @param {IDBFactory | null | undefined} factory */
  async open(factory) {
    if (factory) {
      try {
        this.db = await openDatabase(factory);
        const tx = this.db.transaction(STORES.index, 'readonly');
        /** @type {Array<{key: string, count: number, visited?: number, full?: boolean}>} */
        const rows = await promisify(tx.objectStore(STORES.index).getAll());
        // повторный open не должен удваивать счётчики
        this.index.clear();
        this.totalCells = 0;
        this.aggregates.clear();
        rows.forEach((row) => {
          this.index.set(row.key, { count: row.count, visited: row.visited || 0, full: Boolean(row.full) });
          this.totalCells += row.count;
          this.aggregates.add(row.key, row.count);
        });
        return this;
      } catch (error) {
        this.error = error instanceof StorageError ? error : describeStorageError(error);
        this.db = null;
        this.emit('error', this.error);
      }
    }
    this.loadFromLocalStorage();
    return this;
  }

  loadFromLocalStorage() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.keys(parsed).forEach((key) => {
        const value = parsed[key];
        const bits = typeof value === 'string' ? base64ToBytes(value) : decodeRLE(base64ToBytes(value.rle), CHUNK_BYTES);
        this.place(key, bits, undefined, typeof value === 'object' ? value.visited || 0 : 0);
      });
    } catch (error) {
      /* битое хранилище — начинаем с чистого листа */
    }
  }

  /**
   * Загружает чанки из IndexedDB. Возвращает число загруженных.
   * @param {string[]} keys
   * @returns {Promise<number>}
   */
  load(keys) {
    const need = keys.filter((key) => !this.chunks.has(key) && this.index.has(key));
    if (!need.length || !this.db) {
      // полные чанки без базы восстанавливаем из индекса
      need.forEach((key) => {
        const entry = this.index.get(key);
        if (entry && entry.full) this.place(key, new Uint8Array(CHUNK_BYTES).fill(0xff), undefined, entry.visited);
      });
      return Promise.resolve(0);
    }
    const db = this.db;
    const pending = need.filter((key) => !this.loading.has(key));
    if (pending.length) {
      const batch = new Promise((resolve) => {
        const tx = db.transaction(STORES.chunks, 'readonly');
        const store = tx.objectStore(STORES.chunks);
        let loaded = 0;
        pending.forEach((key) => {
          const request = store.get(key);
          request.onsuccess = () => {
            const row = request.result;
            if (!row || this.chunks.has(key)) return;
            const entry = this.index.get(key);
            this.place(key, rowBits(row), row.heat ? decodeRLE(row.heat, HEAT_SIZE * HEAT_SIZE) : undefined, entry ? entry.visited : 0);
            loaded += 1;
          };
        });
        const finish = () => {
          pending.forEach((key) => this.loading.delete(key));
          this.evict();
          resolve(loaded);
        };
        tx.oncomplete = finish;
        tx.onerror = finish;
        tx.onabort = finish;
      });
      pending.forEach((key) => this.loading.set(key, /** @type {Promise<number>} */ (batch)));
    }
    return Promise.all(need.map((key) => this.loading.get(key) || Promise.resolve(0))).then((counts) => (counts.reduce((a, b) => a + b, 0) ? need.length : 0));
  }

  loadAll() {
    return this.load(Array.from(this.index.keys()));
  }

  /**
   * Кладёт прочитанный чанк в память, согласуя индекс.
   * @param {string} key @param {Uint8Array} bits @param {Uint8Array} [heat] @param {number} [visited]
   */
  place(key, bits, heat, visited = 0) {
    const chunk = new Chunk(key, bits, heat);
    chunk.visited = visited;
    this.chunks.set(key, chunk);
    const entry = this.index.get(key);
    if (!entry || entry.count !== chunk.count) this.syncIndex(chunk);
    return chunk;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DELAY);
  }

  /**
   * Сбрасывает изменённые чанки на диск. При ошибке — до 3 повторов с паузой.
   * @returns {Promise<boolean>}
   */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const dirty = Array.from(this.chunks.values()).filter((chunk) => chunk.dirty);
    if (!dirty.length) return false;
    dirty.forEach((chunk) => {
      chunk.dirty = false;
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.write(dirty);
        this.emit('saved', { keys: dirty.map((c) => c.key) });
        if (this.channel) this.channel.postMessage({ type: 'chunks', keys: dirty.map((c) => c.key) });
        this.evict();
        return true;
      } catch (error) {
        this.error = error instanceof StorageError ? error : describeStorageError(error);
        if (this.error.code === 'quota') break;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
    dirty.forEach((chunk) => {
      chunk.dirty = true;
    });
    this.emit('error', this.error);
    return false;
  }

  /** @param {Chunk[]} chunks */
  async write(chunks) {
    if (this.db) {
      const tx = this.db.transaction([STORES.chunks, STORES.index], 'readwrite');
      const store = tx.objectStore(STORES.chunks);
      const index = tx.objectStore(STORES.index);
      chunks.forEach((chunk) => {
        const full = chunk.count === CHUNK_CELLS;
        if (chunk.count === 0) {
          store.delete(chunk.key);
          index.delete(chunk.key);
          return;
        }
        store.put(full ? { key: chunk.key, full: true, heat: encodeRLE(chunk.heat) } : { key: chunk.key, rle: encodeRLE(chunk.bits), heat: encodeRLE(chunk.heat) });
        index.put({ key: chunk.key, count: chunk.count, visited: chunk.visited, full });
      });
      await done(tx);
      return;
    }
    if (!this.storage) return;
    /** @type {Record<string, {rle: string, visited: number}>} */
    const payload = {};
    this.chunks.forEach((chunk) => {
      if (chunk.count) payload[chunk.key] = { rle: bytesToBase64(encodeRLE(chunk.bits)), visited: chunk.visited };
    });
    try {
      this.storage.setItem(LS_KEY, JSON.stringify(payload));
    } catch (error) {
      throw describeStorageError(error);
    }
  }

  /** Сообщение из другой вкладки: перечитать изменённые чанки. @param {any} message */
  async onBroadcast(message) {
    if (!message || message.type !== 'chunks' || !this.db) return;
    const db = this.db;
    const tx = db.transaction([STORES.chunks, STORES.index], 'readonly');
    /** @type {string[]} */
    const keys = message.keys;
    const rows = await Promise.all(keys.map((key) => Promise.all([promisify(tx.objectStore(STORES.chunks).get(key)), promisify(tx.objectStore(STORES.index).get(key))])));
    rows.forEach(([row, entry], i) => {
      const key = keys[i];
      if (!row || !entry) return;
      const bits = rowBits(row);
      const local = this.chunks.get(key);
      if (local) {
        for (let b = 0; b < bits.length; b += 1) local.bits[b] |= bits[b];
        local.recount();
        local.showAll();
        local.visited = Math.max(local.visited, entry.visited || 0);
        this.syncIndex(local);
      } else {
        const prev = this.index.get(key);
        const delta = entry.count - (prev ? prev.count : 0);
        this.totalCells += delta;
        this.aggregates.add(key, delta);
        this.index.set(key, { count: entry.count, visited: entry.visited || 0, full: Boolean(entry.full) });
      }
    });
    this.emit('external', { keys });
  }

  async clear() {
    this.chunks.clear();
    this.index.clear();
    this.aggregates.clear();
    this.totalCells = 0;
    this.undoSnapshot = null;
    if (this.db) {
      const tx = this.db.transaction([STORES.chunks, STORES.index], 'readwrite');
      tx.objectStore(STORES.chunks).clear();
      tx.objectStore(STORES.index).clear();
      await done(tx);
    } else if (this.storage) {
      try {
        this.storage.removeItem(LS_KEY);
      } catch (error) {
        /* ignore */
      }
    }
    if (this.channel) this.channel.postMessage({ type: 'cleared' });
    this.emit('cleared');
  }

  /** Просит браузер не вытеснять базу. */
  async requestPersistence() {
    const storage = globalThis.navigator && navigator.storage;
    if (!storage || !storage.persist) return false;
    return (await storage.persisted()) || storage.persist();
  }

  /** @returns {Promise<{usage: number, quota: number, persisted: boolean} | null>} */
  async estimate() {
    const storage = globalThis.navigator && navigator.storage;
    if (!storage || !storage.estimate) return null;
    const { usage = 0, quota = 0 } = await storage.estimate();
    const persisted = storage.persisted ? await storage.persisted() : false;
    return { usage, quota, persisted };
  }

  // ---------- обмен ----------

  /** Экспорт v2: RLE + метки посещения + контрольная сумма. */
  async exportJSON() {
    await this.loadAll();
    /** @type {Record<string, {rle: string, visited: number}>} */
    const chunks = {};
    const keys = Array.from(this.chunks.keys())
      .filter((key) => (this.chunks.get(key) || { count: 0 }).count)
      .sort();
    keys.forEach((key) => {
      const chunk = /** @type {Chunk} */ (this.chunks.get(key));
      chunks[key] = { rle: bytesToBase64(encodeRLE(chunk.bits)), visited: chunk.visited };
    });
    const checksum = fnv1a(keys.flatMap((key) => [key, chunks[key].rle]));
    return JSON.stringify({
      format: 'terra-incognita-fog',
      version: 2,
      cellZoom: CELL_ZOOM,
      chunkBits: CHUNK_BITS,
      exportedAt: new Date().toISOString(),
      cells: this.totalCells,
      checksum,
      chunks
    });
  }

  /** @returns {Promise<{blob: Blob, gzip: boolean}>} */
  async exportBlob() {
    const text = await this.exportJSON();
    const plain = new Blob([text], { type: 'application/json' });
    if (typeof CompressionStream === 'undefined') return { blob: plain, gzip: false };
    const stream = plain.stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    return { blob: new Blob([blob], { type: 'application/gzip' }), gzip: true };
  }

  /**
   * Разбор файла экспорта (v1 или v2) в карту key → {bits, visited}.
   * @param {string} text
   */
  static parseExport(text) {
    const parsed = JSON.parse(text);
    if (parsed.format !== 'terra-incognita-fog' || parsed.cellZoom !== CELL_ZOOM || parsed.chunkBits !== CHUNK_BITS) {
      throw new Error('Файл другого формата или другой сетки');
    }
    /** @type {Map<string, {bits: Uint8Array, visited: number}>} */
    const out = new Map();
    const keys = Object.keys(parsed.chunks || {});
    if (parsed.version === 2) {
      const expected = fnv1a(
        keys
          .slice()
          .sort()
          .flatMap((key) => [key, parsed.chunks[key].rle])
      );
      if (parsed.checksum && parsed.checksum !== expected) throw new Error('Файл повреждён: контрольная сумма не совпадает');
      keys.forEach((key) => out.set(key, { bits: decodeRLE(base64ToBytes(parsed.chunks[key].rle), CHUNK_BYTES), visited: parsed.chunks[key].visited || 0 }));
    } else {
      keys.forEach((key) => out.set(key, { bits: base64ToBytes(parsed.chunks[key]), visited: 0 }));
    }
    return out;
  }

  /**
   * Импорт с режимом: union — добавить, replace — заменить всё, subtract — вычесть.
   * Состояние до импорта сохраняется для undoImport().
   * @param {string} text @param {ImportMode} [mode]
   */
  async importJSON(text, mode = 'union') {
    const incoming = FogStore.parseExport(text);
    await this.loadAll();
    /** @type {Map<string, Uint8Array | null>} */
    const touched = new Map();
    const keys = mode === 'replace' ? new Set([...this.chunks.keys(), ...incoming.keys()]) : new Set(incoming.keys());
    keys.forEach((key) => {
      const existing = this.chunks.get(key);
      touched.set(key, existing ? existing.bits.slice() : null);
      const data = incoming.get(key);
      const chunk = existing || new Chunk(key);
      if (!existing) this.chunks.set(key, chunk);
      if (mode === 'union' && data) {
        for (let i = 0; i < CHUNK_BYTES; i += 1) chunk.bits[i] |= data.bits[i];
      } else if (mode === 'replace') {
        chunk.bits.set(data ? data.bits : new Uint8Array(CHUNK_BYTES));
      } else if (mode === 'subtract' && data) {
        for (let i = 0; i < CHUNK_BYTES; i += 1) chunk.bits[i] &= ~data.bits[i];
      }
      if (data) chunk.visited = Math.max(chunk.visited, data.visited);
      chunk.recount();
      chunk.shown = chunk.bits.slice();
      chunk.version += 1;
      chunk.dirty = true;
      this.syncIndex(chunk);
    });
    this.undoSnapshot = { touched, mode };
    await this.flush();
    this.emit('imported', { keys: [...keys], mode });
    return keys.size;
  }

  /** @param {Blob} blob @param {ImportMode} [mode] */
  async importBlob(blob, mode = 'union') {
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;
    let text;
    if (isGzip) {
      if (typeof DecompressionStream === 'undefined') throw new Error('браузер не умеет распаковывать gzip');
      text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      text = await blob.text();
    }
    return this.importJSON(text, mode);
  }

  /** Отменяет последний импорт. */
  async undoImport() {
    const snapshot = this.undoSnapshot;
    if (!snapshot) return false;
    snapshot.touched.forEach((bits, key) => {
      const chunk = this.chunks.get(key) || new Chunk(key);
      this.chunks.set(key, chunk);
      chunk.bits.set(bits || new Uint8Array(CHUNK_BYTES));
      chunk.recount();
      chunk.shown = chunk.bits.slice();
      chunk.version += 1;
      chunk.dirty = true;
      this.syncIndex(chunk);
    });
    this.undoSnapshot = null;
    await this.flush();
    this.emit('imported', { keys: [...snapshot.touched.keys()], mode: 'undo' });
    return true;
  }

  /**
   * Экспорт в ячейки H3. h3 — библиотека h3-js v4.
   * @param {any} h3 @param {number} resolution
   */
  async exportH3(h3, resolution) {
    await this.loadAll();
    /** @type {Set<string>} */
    const set = new Set();
    this.forEachCell((lat, lng) => set.add(h3.latLngToCell(lat, lng, resolution)));
    const cells = Array.from(set);
    return JSON.stringify({ format: 'terra-incognita-h3', version: 1, resolution, exportedAt: new Date().toISOString(), cellCount: cells.length, cells: h3.compactCells(cells) });
  }

  /**
   * Импорт набора H3: каждая ячейка растрируется в клетки сетки.
   * @param {any} h3 @param {string} text
   */
  async importH3(h3, text) {
    const parsed = JSON.parse(text);
    const cells = Array.isArray(parsed) ? parsed : parsed.cells;
    if (!Array.isArray(cells)) throw new Error('В файле нет списка ячеек H3');
    const resolution = parsed.resolution || Math.max(...cells.map((/** @type {string} */ c) => h3.getResolution(c)));
    const all = h3.uncompactCells(cells, resolution);
    let added = 0;
    for (const cell of all) {
      /** @type {Array<[number, number]>} */
      const ring = h3.cellToBoundary(cell).map((/** @type {[number, number]} */ [lat, lng]) => [lng, lat]);
      added += await this.revealRing(ring);
    }
    await this.flush();
    return { cells: all.length, added };
  }

  /**
   * Экспорт открытого в GeoJSON: контуры обходом границ клеток в каждом чанке.
   * Внешние кольца — против часовой стрелки, дыры привязаны к содержащему кольцу.
   */
  async exportGeoJSON() {
    await this.loadAll();
    /** @type {any[]} */
    const features = [];
    this.chunks.forEach((chunk) => {
      if (!chunk.count) return;
      const polygons = traceChunk(chunk);
      if (!polygons.length) return;
      features.push({
        type: 'Feature',
        properties: { chunk: chunk.key, cells: chunk.count, visited: chunk.visited ? new Date(chunk.visited).toISOString() : null },
        geometry: { type: 'MultiPolygon', coordinates: polygons }
      });
    });
    return JSON.stringify({ type: 'FeatureCollection', features });
  }
}

/** @param {any} row @returns {Uint8Array} */
function rowBits(row) {
  if (row.full) return new Uint8Array(CHUNK_BYTES).fill(0xff);
  if (row.rle) return decodeRLE(row.rle instanceof Uint8Array ? row.rle : new Uint8Array(row.rle), CHUNK_BYTES);
  if (row.bits) return row.bits instanceof Uint8Array ? row.bits : new Uint8Array(row.bits);
  return new Uint8Array(CHUNK_BYTES);
}

/** @param {LatLng[]} points @param {number} marginMeters @returns {Bounds} */
export function boundsOf(points, marginMeters) {
  let north = -90;
  let south = 90;
  let west = 180;
  let east = -180;
  points.forEach((p) => {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  });
  const dLat = marginMeters / 111320;
  const dLng = marginMeters / (111320 * Math.max(0.01, Math.cos(((north + south) / 2) * (Math.PI / 180))));
  return { north: north + dLat, south: south - dLat, west: west - dLng, east: east + dLng };
}

/**
 * Обход контуров открытых клеток чанка.
 * Каждое ребро между открытой и закрытой клеткой направлено так, что открытая слева;
 * рёбра сшиваются в кольца. Возвращает полигоны GeoJSON [lng, lat].
 * @param {Chunk} chunk
 */
export function traceChunk(chunk) {
  const S = CHUNK_SIZE;
  /** @param {number} x @param {number} y */
  const on = (x, y) => x >= 0 && y >= 0 && x < S && y < S && chunk.has(x, y) === 1;
  /** @type {Map<number, number[]>} старт вершины → концы */
  const edges = new Map();
  const vid = (/** @type {number} */ x, /** @type {number} */ y) => y * (S + 1) + x;
  /** @param {number} a @param {number} b */
  const addEdge = (a, b) => {
    const list = edges.get(a);
    if (list) list.push(b);
    else edges.set(a, [b]);
  };
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      if (!on(x, y)) continue;
      // экранные координаты: y вниз. Обход так, чтобы клетка была слева в системе «y вверх» после переворота.
      if (!on(x, y - 1)) addEdge(vid(x + 1, y), vid(x, y));
      if (!on(x, y + 1)) addEdge(vid(x, y + 1), vid(x + 1, y + 1));
      if (!on(x - 1, y)) addEdge(vid(x, y), vid(x, y + 1));
      if (!on(x + 1, y)) addEdge(vid(x + 1, y + 1), vid(x + 1, y));
    }
  }
  /** @type {Array<Array<[number, number]>>} */
  const rings = [];
  while (edges.size) {
    const [start] = edges.keys();
    /** @type {number[]} */
    const ring = [start];
    let current = start;
    for (;;) {
      const list = edges.get(current);
      if (!list || !list.length) break;
      const next = /** @type {number} */ (list.pop());
      if (!list.length) edges.delete(current);
      if (next === start) break;
      ring.push(next);
      current = next;
    }
    const baseX = chunk.cx << CHUNK_BITS;
    const baseY = chunk.cy << CHUNK_BITS;
    /** @type {Array<[number, number]>} */
    const coords = simplifyCollinear(ring.map((v) => [v % (S + 1), Math.floor(v / (S + 1))])).map(([x, y]) => {
      const p = unproject(baseX + x, baseY + y, CELL_ZOOM);
      return /** @type {[number, number]} */ ([+p.lng.toFixed(7), +p.lat.toFixed(7)]);
    });
    coords.push(coords[0]);
    rings.push(coords);
  }
  // знак площади в координатах [lng, lat]: > 0 — против часовой (внешнее кольцо)
  const signed = (/** @type {Array<[number, number]>} */ r) => {
    let s = 0;
    for (let i = 0; i < r.length - 1; i += 1) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return s / 2;
  };
  const outers = rings.filter((r) => signed(r) > 0).map((r) => [r]);
  rings
    .filter((r) => signed(r) <= 0)
    .forEach((hole) => {
      const [lng, lat] = hole[0];
      const owner = outers.find((poly) => pointInRing(lat, lng, poly[0]));
      if (owner) owner.push(hole);
    });
  return outers;
}

/** Убирает промежуточные вершины на прямых отрезках. @param {Array<[number, number]>} pts */
function simplifyCollinear(pts) {
  /** @type {Array<[number, number]>} */
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const collinear = (prev[0] === cur[0] && cur[0] === next[0]) || (prev[1] === cur[1] && cur[1] === next[1]);
    if (!collinear) out.push(cur);
  }
  return out.length ? out : pts;
}

export { POPCOUNT };
