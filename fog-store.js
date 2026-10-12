/*
 * Хранилище открытых областей.
 *
 * Мир нарезан на клетки тайловой сетки Web Mercator на зуме CELL_ZOOM (22):
 * у экватора клетка ≈ 9.6 м, в Париже ≈ 6.3 м. Клетки группируются в чанки
 * 256×256 (это тайлы зума CHUNK_ZOOM = 14, ≈ 2.4 км). Чанк — битовая карта
 * на 8 КБ, поэтому даже сотни квадратных километров пройденного пути весят
 * мегабайты, а проверка и запись клетки стоят одну битовую операцию.
 *
 * Чанки лежат в IndexedDB (запасной вариант — localStorage). При старте читается
 * только лёгкий индекс {key, count}; сами битовые карты подгружаются для видимой
 * области и окрестности путешественника. Запись отложенная:
 * изменённые чанки сбрасываются через SAVE_DELAY мс после последнего изменения
 * и принудительно при уходе со страницы.
 *
 * Для отрисовки у каждого чанка есть кэшированный canvas 256×256, где открытая
 * клетка — непрозрачный пиксель. Пелена рисует один drawImage на видимый чанк,
 * сколько бы клеток в нём ни было.
 */
(function (root) {
  const CELL_ZOOM = 22;
  const CHUNK_BITS = 8;                       // 256 клеток на сторону чанка
  const CHUNK_SIZE = 1 << CHUNK_BITS;
  const CHUNK_ZOOM = CELL_ZOOM - CHUNK_BITS;  // 14
  const BYTES_PER_CHUNK = (CHUNK_SIZE * CHUNK_SIZE) / 8;
  const EARTH_CIRCUMFERENCE = 40075016.686;
  const SAVE_DELAY = 800;
  const DB_NAME = 'terra-incognita';
  const DB_VERSION = 2;
  const STORE = 'chunks';
  const INDEX_STORE = 'chunk-index';   // {key, count} — лёгкий список всех чанков
  const LS_KEY = 'terra-fog-chunks';

  const POPCOUNT = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

  function project(lat, lng, zoom) {
    const scale = Math.pow(2, zoom);
    const sin = Math.sin(lat * Math.PI / 180);
    const x = (lng + 180) / 360 * scale;
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  function unproject(x, y, zoom) {
    const scale = Math.pow(2, zoom);
    const lng = x / scale * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / scale;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  function metersPerCell(lat) {
    return EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / Math.pow(2, CELL_ZOOM);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  class Chunk {
    constructor(key, cx, cy, bits) {
      this.key = key;
      this.cx = cx;           // индекс чанка по x (тайл зума CHUNK_ZOOM)
      this.cy = cy;
      this.bits = bits || new Uint8Array(BYTES_PER_CHUNK);
      this.shown = this.bits.slice();   // то, что уже отрисовано (без текущей анимации)
      this.count = 0;
      for (let i = 0; i < this.bits.length; i += 1) this.count += POPCOUNT[this.bits[i]];
      this.dirty = false;
      this.canvas = null;
      this.canvasStale = true;
    }

    static index(lx, ly) { return (ly << CHUNK_BITS) | lx; }

    has(lx, ly) {
      const i = Chunk.index(lx, ly);
      return (this.bits[i >> 3] >> (i & 7)) & 1;
    }

    set(lx, ly) {
      const i = Chunk.index(lx, ly);
      const mask = 1 << (i & 7);
      if (this.bits[i >> 3] & mask) return false;
      this.bits[i >> 3] |= mask;
      this.count += 1;
      this.dirty = true;
      return true;
    }

    show(i) {
      const mask = 1 << (i & 7);
      if (this.shown[i >> 3] & mask) return;
      this.shown[i >> 3] |= mask;
      this.canvasStale = true;
    }

    showAll() {
      this.shown.set(this.bits);
      this.canvasStale = true;
    }

    image() {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = CHUNK_SIZE;
        this.canvas.height = CHUNK_SIZE;
      }
      if (this.canvasStale) {
        const context = this.canvas.getContext('2d');
        const data = context.createImageData(CHUNK_SIZE, CHUNK_SIZE);
        const px = data.data;
        for (let i = 0; i < this.shown.length; i += 1) {
          const byte = this.shown[i];
          if (!byte) continue;
          for (let b = 0; b < 8; b += 1) {
            if (byte & (1 << b)) {
              const o = ((i << 3) | b) << 2;
              px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = 255;
            }
          }
        }
        context.putImageData(data, 0, 0);
        this.canvasStale = false;
      }
      return this.canvas;
    }
  }

  class FogStore {
    constructor() {
      this.chunks = new Map();     // загруженные чанки
      this.index = new Map();      // key -> число открытых клеток, для всех чанков в хранилище
      this.loading = new Map();    // key -> Promise загрузки
      this.totalCells = 0;
      this.onChunksLoaded = null;
      this.saveTimer = null;
      this.db = null;
      this.ready = this.open();
      this.onSaved = null;
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => this.flush());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
      }
    }

    // ---------- геометрия ----------

    cellOf(lat, lng) {
      const p = project(lat, lng, CELL_ZOOM);
      return { x: Math.floor(p.x), y: Math.floor(p.y) };
    }

    chunkBounds(chunk) {
      const nw = unproject(chunk.cx, chunk.cy, CHUNK_ZOOM);
      const se = unproject(chunk.cx + 1, chunk.cy + 1, CHUNK_ZOOM);
      return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
    }

    chunkAt(cellX, cellY, create) {
      const cx = cellX >> CHUNK_BITS;
      const cy = cellY >> CHUNK_BITS;
      const key = `${CHUNK_ZOOM}/${cx}/${cy}`;
      let chunk = this.chunks.get(key);
      if (!chunk && create) {
        chunk = new Chunk(key, cx, cy);
        this.chunks.set(key, chunk);
      }
      return chunk;
    }

    isRevealed(lat, lng) {
      const c = this.cellOf(lat, lng);
      const chunk = this.chunkAt(c.x, c.y, false);
      return chunk ? Boolean(chunk.has(c.x & (CHUNK_SIZE - 1), c.y & (CHUNK_SIZE - 1))) : false;
    }

    /**
     * Открывает круг радиусом radiusMeters вокруг точки.
     * Возвращает список новых клеток [{chunk, index}] — для анимации проявления.
     */
    reveal(lat, lng, radiusMeters) {
      const center = project(lat, lng, CELL_ZOOM);
      const r = radiusMeters / metersPerCell(lat);
      const added = [];
      const minY = Math.floor(center.y - r);
      const maxY = Math.floor(center.y + r);
      for (let cy = minY; cy <= maxY; cy += 1) {
        const dy = (cy + 0.5) - center.y;
        const half = Math.sqrt(Math.max(0, r * r - dy * dy));
        const minX = Math.floor(center.x - half);
        const maxX = Math.floor(center.x + half);
        for (let cx = minX; cx <= maxX; cx += 1) {
          const chunk = this.chunkAt(cx, cy, true);
          const lx = cx & (CHUNK_SIZE - 1);
          const ly = cy & (CHUNK_SIZE - 1);
          if (chunk.set(lx, ly)) {
            this.totalCells += 1;
            this.index.set(chunk.key, chunk.count);
            added.push({ chunk, index: Chunk.index(lx, ly) });
          }
        }
      }
      if (added.length) this.scheduleSave();
      return added;
    }

    /** Площадь открытого в квадратных метрах (приближённо, по широте точки отсчёта). */
    revealedArea(lat) {
      const m = metersPerCell(lat);
      return this.totalCells * m * m;
    }

    /** Чанки, пересекающие прямоугольник широт/долгот. */
    chunksInBounds(bounds) {
      const keys = this.keysInBounds(bounds);
      const out = [];
      const missing = [];
      keys.forEach((key) => {
        const chunk = this.chunks.get(key);
        if (chunk) { if (chunk.count) out.push(chunk); } else missing.push(key);
      });
      if (missing.length) {
        this.load(missing).then((loaded) => { if (loaded && this.onChunksLoaded) this.onChunksLoaded(); });
      }
      return out;
    }

    /** Ключи сохранённых чанков, пересекающих прямоугольник. */
    keysInBounds(bounds) {
      const nw = project(bounds.north, bounds.west, CHUNK_ZOOM);
      const se = project(bounds.south, bounds.east, CHUNK_ZOOM);
      const x0 = Math.floor(nw.x); const x1 = Math.floor(se.x);
      const y0 = Math.floor(nw.y); const y1 = Math.floor(se.y);
      const out = [];
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= this.index.size) {
        for (let y = y0; y <= y1; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            const key = `${CHUNK_ZOOM}/${x}/${y}`;
            if (this.index.get(key)) out.push(key);
          }
        }
      } else {
        this.index.forEach((count, key) => {
          if (!count) return;
          const [, x, y] = key.split('/').map(Number);
          if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(key);
        });
      }
      return out;
    }

    /** Подгружает чанки вокруг точки, чтобы reveal() не затёр несчитанные данные. */
    ensureAround(lat, lng, radiusMeters) {
      const dLat = radiusMeters / 111320;
      const dLng = radiusMeters / (111320 * Math.max(.01, Math.cos(lat * Math.PI / 180)));
      const keys = this.keysInBounds({ north: lat + dLat, south: lat - dLat, west: lng - dLng, east: lng + dLng });
      return this.load(keys.filter((key) => !this.chunks.has(key)));
    }

    /** Загружает из IndexedDB указанные чанки. Возвращает число реально загруженных. */
    load(keys) {
      const need = keys.filter((key) => !this.chunks.has(key) && this.index.has(key));
      if (!need.length || !this.db) return Promise.resolve(0);
      const pending = need.filter((key) => !this.loading.has(key));
      if (pending.length) {
        const batch = new Promise((resolve) => {
          const tx = this.db.transaction(STORE, 'readonly');
          const store = tx.objectStore(STORE);
          let loaded = 0;
          pending.forEach((key) => {
            const request = store.get(key);
            request.onsuccess = () => {
              const row = request.result;
              if (row && !this.chunks.has(key)) { this.place(key, row.bits); loaded += 1; }
            };
          });
          tx.oncomplete = () => { pending.forEach((key) => this.loading.delete(key)); resolve(loaded); };
          tx.onerror = () => { pending.forEach((key) => this.loading.delete(key)); resolve(loaded); };
        });
        pending.forEach((key) => this.loading.set(key, batch));
      }
      return Promise.all(need.map((key) => this.loading.get(key) || Promise.resolve(0)))
        .then((counts) => counts.reduce((a, b) => a + b, 0) ? need.length : 0);
    }

    /** Загружает всё — для экспорта. */
    loadAll() {
      return this.load(Array.from(this.index.keys()));
    }

    /** Кладёт прочитанный из хранилища чанк, не меняя totalCells (он уже учтён индексом). */
    place(key, bytes) {
      const [, cx, cy] = key.split('/').map(Number);
      const chunk = new Chunk(key, cx, cy, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      this.chunks.set(key, chunk);
      if (this.index.get(key) !== chunk.count) {
        this.totalCells += chunk.count - (this.index.get(key) || 0);
        this.index.set(key, chunk.count);
      }
      return chunk;
    }

    // ---------- хранение ----------

    open() {
      if (typeof indexedDB === 'undefined') return this.loadFromLocalStorage();
      return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
          if (!db.objectStoreNames.contains(INDEX_STORE)) {
            const indexStore = db.createObjectStore(INDEX_STORE, { keyPath: 'key' });
            if (event.oldVersion >= 1) {
              // миграция с версии 1: строим индекс по уже сохранённым чанкам
              const cursor = request.transaction.objectStore(STORE).openCursor();
              cursor.onsuccess = () => {
                const c = cursor.result;
                if (!c) return;
                const bits = c.value.bits;
                let count = 0;
                for (let i = 0; i < bits.length; i += 1) count += POPCOUNT[bits[i]];
                indexStore.put({ key: c.value.key, count });
                c.continue();
              };
            }
          }
        };
        request.onerror = () => resolve(this.loadFromLocalStorage());
        request.onsuccess = () => {
          this.db = request.result;
          const tx = this.db.transaction(INDEX_STORE, 'readonly');
          const all = tx.objectStore(INDEX_STORE).getAll();
          all.onsuccess = () => {
            (all.result || []).forEach((row) => {
              this.index.set(row.key, row.count);
              this.totalCells += row.count;
            });
            resolve(this);
          };
          all.onerror = () => resolve(this);
        };
      });
    }

    adopt(key, bytes) {
      const [, cx, cy] = key.split('/').map(Number);
      const bits = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const existing = this.chunks.get(key);
      if (existing) {
        for (let i = 0; i < bits.length; i += 1) existing.bits[i] |= bits[i];
        this.totalCells -= existing.count;
        existing.count = 0;
        for (let i = 0; i < existing.bits.length; i += 1) existing.count += POPCOUNT[existing.bits[i]];
        this.totalCells += existing.count;
        this.index.set(key, existing.count);
        existing.showAll();
        existing.dirty = true;
        return existing;
      }
      const chunk = new Chunk(key, cx, cy, bits);
      this.chunks.set(key, chunk);
      this.totalCells += chunk.count - (this.index.get(key) || 0);
      this.index.set(key, chunk.count);
      return chunk;
    }

    loadFromLocalStorage() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          Object.keys(parsed).forEach((key) => this.adopt(key, base64ToBytes(parsed[key])));
        }
      } catch (error) { /* пустое или битое хранилище — начинаем с чистого листа */ }
      return Promise.resolve(this);
    }

    scheduleSave() {
      if (this.saveTimer) return;
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY);
    }

    flush() {
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      const dirty = [];
      this.chunks.forEach((chunk) => { if (chunk.dirty) dirty.push(chunk); });
      if (!dirty.length) return Promise.resolve(false);
      dirty.forEach((chunk) => { chunk.dirty = false; });
      if (this.db) {
        return new Promise((resolve) => {
          const tx = this.db.transaction([STORE, INDEX_STORE], 'readwrite');
          const store = tx.objectStore(STORE);
          const indexStore = tx.objectStore(INDEX_STORE);
          dirty.forEach((chunk) => {
            store.put({ key: chunk.key, bits: chunk.bits });
            indexStore.put({ key: chunk.key, count: chunk.count });
          });
          tx.oncomplete = () => { if (this.onSaved) this.onSaved(); resolve(true); };
          tx.onerror = () => { dirty.forEach((chunk) => { chunk.dirty = true; }); resolve(false); };
        });
      }
      try {
        const payload = {};
        this.chunks.forEach((chunk) => { if (chunk.count) payload[chunk.key] = bytesToBase64(chunk.bits); });
        localStorage.setItem(LS_KEY, JSON.stringify(payload));
        if (this.onSaved) this.onSaved();
        return Promise.resolve(true);
      } catch (error) {
        dirty.forEach((chunk) => { chunk.dirty = true; });
        return Promise.resolve(false);
      }
    }

    clear() {
      this.chunks.clear();
      this.index.clear();
      this.totalCells = 0;
      if (this.db) {
        return new Promise((resolve) => {
          const tx = this.db.transaction([STORE, INDEX_STORE], 'readwrite');
          tx.objectStore(STORE).clear();
          tx.objectStore(INDEX_STORE).clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      }
      try { localStorage.removeItem(LS_KEY); } catch (error) { /* ignore */ }
      return Promise.resolve(true);
    }

    // ---------- обмен ----------

    /** JSON со всеми чанками (сначала догружает всё из хранилища). */
    exportJSON() {
      return this.loadAll().then(() => {
        const chunks = {};
        this.chunks.forEach((chunk) => { if (chunk.count) chunks[chunk.key] = bytesToBase64(chunk.bits); });
        return JSON.stringify({ format: 'terra-incognita-fog', version: 1, cellZoom: CELL_ZOOM, chunkBits: CHUNK_BITS, exportedAt: new Date().toISOString(), chunks });
      });
    }

    /**
     * Экспорт, сжатый gzip, если браузер умеет CompressionStream.
     * Возвращает {blob, gzip}.
     */
    exportBlob() {
      return this.exportJSON().then((text) => {
        const plain = new Blob([text], { type: 'application/json' });
        if (typeof CompressionStream === 'undefined') return { blob: plain, gzip: false };
        const stream = plain.stream().pipeThrough(new CompressionStream('gzip'));
        return new Response(stream).blob().then((blob) => ({ blob: new Blob([blob], { type: 'application/gzip' }), gzip: true }));
      });
    }

    /** Принимает File/Blob: обычный JSON или gzip. */
    importBlob(blob) {
      return blob.slice(0, 2).arrayBuffer().then((head) => {
        const bytes = new Uint8Array(head);
        const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
        if (!isGzip) return blob.text();
        if (typeof DecompressionStream === 'undefined') throw new Error('браузер не умеет распаковывать gzip');
        return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
      }).then((text) => this.importJSON(text));
    }

    importJSON(text) {
      const parsed = JSON.parse(text);
      if (parsed.format !== 'terra-incognita-fog' || parsed.cellZoom !== CELL_ZOOM || parsed.chunkBits !== CHUNK_BITS) {
        return Promise.reject(new Error('Файл другого формата или другой сетки'));
      }
      const keys = Object.keys(parsed.chunks || {});
      // сначала догружаем пересекающиеся чанки, чтобы объединить, а не перезаписать
      return this.load(keys).then(() => {
        keys.forEach((key) => {
          const chunk = this.adopt(key, base64ToBytes(parsed.chunks[key]));
          chunk.dirty = true;
        });
        this.scheduleSave();
        return keys.length;
      });
    }
  }

  /**
   * Перебор всех открытых клеток: callback(lat, lng) с центром клетки.
   */
  FogStore.prototype.forEachCell = function (callback) {
    this.chunks.forEach((chunk) => {
      const baseX = chunk.cx << CHUNK_BITS;
      const baseY = chunk.cy << CHUNK_BITS;
      for (let i = 0; i < chunk.bits.length; i += 1) {
        const byte = chunk.bits[i];
        if (!byte) continue;
        for (let b = 0; b < 8; b += 1) {
          if (!(byte & (1 << b))) continue;
          const index = (i << 3) | b;
          const p = unproject(baseX + (index & (CHUNK_SIZE - 1)) + 0.5, baseY + (index >> CHUNK_BITS) + 0.5, CELL_ZOOM);
          callback(p.lat, p.lng);
        }
      }
    });
  };

  /**
   * Экспорт в ячейки H3 (Uber). h3 — объект библиотеки h3-js v4.
   * Клетка попадает в гекс по своему центру; результат сжат compactCells.
   */
  FogStore.prototype.exportH3 = function (h3, resolution) {
    return this.loadAll().then(() => {
      const set = new Set();
      this.forEachCell((lat, lng) => set.add(h3.latLngToCell(lat, lng, resolution)));
      const cells = Array.from(set);
      const compact = h3.compactCells(cells);
      return JSON.stringify({ format: 'terra-incognita-h3', version: 1, resolution, exportedAt: new Date().toISOString(), cellCount: cells.length, cells: compact });
    });
  };

  FogStore.CELL_ZOOM = CELL_ZOOM;
  FogStore.CHUNK_ZOOM = CHUNK_ZOOM;
  FogStore.CHUNK_SIZE = CHUNK_SIZE;
  FogStore.project = project;
  FogStore.unproject = unproject;
  FogStore.metersPerCell = metersPerCell;
  FogStore.Chunk = Chunk;

  root.FogStore = FogStore;
})(typeof window !== 'undefined' ? window : globalThis);
