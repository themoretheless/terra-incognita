// @ts-check
/**
 * Рендер пелены поверх подложки.
 *
 * Слои (снизу вверх): подложка → overlay (тепловая карта, трек, сравнение) → пелена.
 * Пелена = заливка темы с текстурой, из которой вырезается маска открытого.
 * Маска собирается из кэшированных картинок чанков: одна drawImage на видимый чанк.
 *
 * Оптимизации:
 *  - кадр рисуется только по запросу (requestDraw), не чаще одного на rAF;
 *  - картинки чанков строятся в воркере (OffscreenCanvas → ImageBitmap);
 *  - уровень детализации по размеру чанка на экране (256/128/64/32 px);
 *  - мягкий край — билинейное растяжение уменьшенного покрытия, без blur();
 *  - кэш картинок ограничен и чистится при вытеснении чанка из памяти.
 */
import { rasterizeMask, rasterizeHeat } from './raster.js';
import { project, unproject } from '../geo.js';

const FOG_COLORS = {
  terra: 'rgba(16, 27, 40, .94)',
  heroes: 'rgba(0, 0, 0, .98)',
  western: 'rgba(226, 205, 168, .86)'
};
const CACHE_LIMIT = 600;
const LEVELS = [32, 64, 128, 256];
const MOSAIC_SPAN = 16; // чанков по стороне мозаики (= тайл z10)
const MOSAIC_LEVEL = 32; // пикселей на чанк внутри мозаики
const MOSAIC_MAX_PX = 160; // до этого размера чанка levelFor и так выбирает уровень 32

/**
 * @typedef {import('../fog-store.js').FogStore} FogStore
 * @typedef {import('../fog-store.js').Chunk} Chunk
 * @typedef {{ id: string, lat: number, lng: number, cells: Array<{chunk: Chunk, index: number}>, createdAt: number, duration: number, radius: number }} RevealSpot
 * @typedef {{ bitmap: CanvasImageSource | null, version: number, pending: boolean, used: number }} CacheEntry
 */

export class FogRenderer {
  /**
   * @param {{ view: any, fog: FogStore, viewport: HTMLElement, canvas: HTMLCanvasElement, overlay: HTMLCanvasElement,
   *   getTheme: () => string, getMode: () => string, getSettings: () => any }} options
   */
  constructor(options) {
    this.view = options.view;
    this.fog = options.fog;
    /** источник данных для отрисовки (для хроники подменяется временным хранилищем) */
    this.source = options.fog;
    this.viewport = options.viewport;
    this.canvas = options.canvas;
    this.overlay = options.overlay;
    this.getTheme = options.getTheme;
    this.getMode = options.getMode;
    this.getSettings = options.getSettings;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    this.octx = /** @type {CanvasRenderingContext2D} */ (this.overlay.getContext('2d'));
    this.mask = document.createElement('canvas');
    this.mctx = /** @type {CanvasRenderingContext2D} */ (this.mask.getContext('2d'));
    this.vision = document.createElement('canvas');
    this.vctx = /** @type {CanvasRenderingContext2D} */ (this.vision.getContext('2d'));
    this.rim = document.createElement('canvas');
    this.rctx = /** @type {CanvasRenderingContext2D} */ (this.rim.getContext('2d'));
    /** @type {RevealSpot[]} */
    this.spots = [];
    this.player = { lat: 0, lng: 0 };
    /** @type {Array<{lat: number, lng: number}>} */
    this.wards = [];
    /** @type {() => Array<Array<{lat: number, lng: number}>>} */
    this.getTracks = () => [];
    /** @type {FogStore | null} */
    this.compare = null;
    /** @type {Array<{ name: string, polygon: Array<Array<Array<[number, number]>>>, ratio: number }>} хороплет районов */
    this.choropleth = [];
    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map();
    /** @type {Map<string, {canvas: HTMLCanvasElement, sig: number}>} */
    this.mosaics = new Map();
    /** @type {any} */
    this.mosaicSource = null;
    /** @type {Map<string, CacheEntry>} */
    this.heatCache = new Map();
    /** @type {Map<string, CacheEntry>} */
    this.compareCache = new Map();
    this.frame = 0;
    this.dirty = true;
    this.width = 0;
    this.height = 0;
    this.dpr = 0;
    /** @type {{ canvas: HTMLCanvasElement, start: number } | null} */
    this.fade = null;
    this.stats = { frameMs: 0, avgMs: 0, chunks: 0, cache: 0, pending: 0, draws: 0 };
    this.reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof matchMedia !== 'undefined') {
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
        this.reducedMotion = e.matches;
      });
    }
    this.worker = this.createWorker();
    /** @type {Map<number, {resolve: (b: ImageBitmap) => void}>} */
    this.jobs = new Map();
    this.jobId = 0;
    this.fog.on('evict', (/** @type {Chunk} */ chunk) => this.forget(chunk.key));
    this.fog.on('cleared', () => {
      this.cache.clear();
      this.mosaics.clear();
      this.heatCache.clear();
      this.requestDraw();
    });
  }

  createWorker() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const worker = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const job = this.jobs.get(event.data.id);
        if (!job) return;
        this.jobs.delete(event.data.id);
        job.resolve(event.data.bitmap);
      };
      worker.onerror = () => {
        this.worker = null;
      };
      return worker;
    } catch (error) {
      return null;
    }
  }

  /** Освобождает картинки чанка. @param {string} key */
  forget(key) {
    [this.cache, this.heatCache].forEach((cache) => {
      [...cache.keys()]
        .filter((k) => k.startsWith(`${key}@`) || k === key)
        .forEach((k) => {
          const entry = cache.get(k);
          if (entry && entry.bitmap && 'close' in entry.bitmap) /** @type {ImageBitmap} */ (entry.bitmap).close();
          cache.delete(k);
        });
    });
  }

  requestDraw() {
    this.dirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  /** @param {RevealSpot} spot */
  addSpot(spot) {
    if (this.reducedMotion) {
      spot.cells.forEach((cell) => cell.chunk.show(cell.index));
    } else {
      this.spots.push(spot);
    }
    this.requestDraw();
  }

  /** Плавная смена темы: старый кадр гаснет поверх нового. */
  crossfade() {
    if (this.reducedMotion || !this.width) return;
    const snap = document.createElement('canvas');
    snap.width = this.canvas.width;
    snap.height = this.canvas.height;
    /** @type {CanvasRenderingContext2D} */ (snap.getContext('2d')).drawImage(this.canvas, 0, 0);
    this.fade = { canvas: snap, start: performance.now() };
    this.requestDraw();
  }

  resize() {
    const rect = this.viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (w === this.width && h === this.height && dpr === this.dpr) return rect;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    [this.canvas, this.overlay, this.mask, this.vision, this.rim].forEach((c) => {
      c.width = w;
      c.height = h;
    });
    return rect;
  }

  /**
   * Картинка маски чанка нужного уровня (из кэша или построенная).
   * @param {Chunk} chunk @param {number} level @param {Map<string, CacheEntry>} cache @param {boolean} [shownOnly]
   * @returns {CanvasImageSource | null}
   */
  maskImage(chunk, level, cache, shownOnly = true) {
    const key = `${chunk.key}@${level}`;
    let entry = cache.get(key);
    const bits = shownOnly ? chunk.shown : chunk.bits;
    if (entry && entry.version === chunk.version && entry.bitmap) {
      entry.used = performance.now();
      return entry.bitmap;
    }
    if (entry && entry.pending) return entry.bitmap;
    const stale = entry ? entry.bitmap : null;
    entry = { bitmap: stale, version: chunk.version, pending: true, used: performance.now() };
    cache.set(key, entry);
    const version = chunk.version;
    if (this.worker) {
      const id = (this.jobId += 1);
      const target = entry;
      new Promise((resolve) => {
        this.jobs.set(id, { resolve: /** @type {any} */ (resolve) });
        /** @type {Worker} */ (this.worker).postMessage({ id, kind: 'mask', data: bits.slice(), size: level });
      }).then((bitmap) => {
        if (target.bitmap && target.bitmap !== bitmap && 'close' in target.bitmap) /** @type {ImageBitmap} */ (target.bitmap).close();
        target.bitmap = /** @type {ImageBitmap} */ (bitmap);
        target.pending = false;
        target.version = version;
        this.requestDraw();
      });
      return stale;
    }
    entry.bitmap = toCanvas(rasterizeMask(bits, level), level);
    entry.pending = false;
    return entry.bitmap;
  }

  /**
   * Рисует видимые чанки через мозаики MOSAIC_SPAN×MOSAIC_SPAN. Мозаика
   * пересобирается, только когда меняется версия одного из её чанков.
   * @param {Chunk[]} chunks @param {CanvasRenderingContext2D} m
   */
  drawMosaics(chunks, m) {
    if (this.mosaicSource !== this.source) {
      this.mosaics.clear();
      this.mosaicSource = this.source;
    }
    /** @type {Map<string, {sx: number, sy: number, list: Chunk[]}>} */
    const groups = new Map();
    chunks.forEach((chunk) => {
      const sx = Math.floor(chunk.cx / MOSAIC_SPAN);
      const sy = Math.floor(chunk.cy / MOSAIC_SPAN);
      const key = `${sx}:${sy}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { sx, sy, list: [] }));
      g.list.push(chunk);
    });
    const side = MOSAIC_SPAN * MOSAIC_LEVEL;
    groups.forEach((g, key) => {
      let sig = 0;
      g.list.forEach((c) => {
        sig = (sig * 31 + c.version * 7 + c.cx * 3 + c.cy) | 0;
      });
      sig = (sig * 31 + g.list.length) | 0;
      let entry = this.mosaics.get(key);
      if (!entry || entry.sig !== sig) {
        const canvas = entry ? entry.canvas : document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const c = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        c.clearRect(0, 0, side, side);
        let complete = true;
        g.list.forEach((chunk) => {
          const img = this.maskImage(chunk, MOSAIC_LEVEL, this.cache);
          const e = this.cache.get(`${chunk.key}@${MOSAIC_LEVEL}`);
          if (!img || (e && e.pending)) complete = false;
          if (img) c.drawImage(img, (chunk.cx - g.sx * MOSAIC_SPAN) * MOSAIC_LEVEL, (chunk.cy - g.sy * MOSAIC_SPAN) * MOSAIC_LEVEL);
        });
        // неполную мозаику пересоберём, когда воркер вернёт картинки
        entry = { canvas, sig: complete ? sig : NaN };
        this.mosaics.set(key, entry);
      }
      const nw = this.view.project(...latLngOf(g.sx * MOSAIC_SPAN, g.sy * MOSAIC_SPAN));
      const se = this.view.project(...latLngOf((g.sx + 1) * MOSAIC_SPAN, (g.sy + 1) * MOSAIC_SPAN));
      m.drawImage(entry.canvas, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    });
    if (this.mosaics.size > 64) {
      const visible = new Set(groups.keys());
      [...this.mosaics.keys()].forEach((k) => !visible.has(k) && this.mosaics.delete(k));
    }
  }

  /** @param {Chunk} chunk */
  heatImage(chunk) {
    let entry = this.heatCache.get(chunk.key);
    if (entry && entry.version === chunk.heatVersion) return entry.bitmap;
    entry = { bitmap: toCanvas(rasterizeHeat(chunk.heat), 64), version: chunk.heatVersion, pending: false, used: performance.now() };
    this.heatCache.set(chunk.key, entry);
    return entry.bitmap;
  }

  trimCache() {
    if (this.cache.size <= CACHE_LIMIT) return;
    const sorted = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    sorted.slice(0, this.cache.size - CACHE_LIMIT).forEach(([k, entry]) => {
      if (entry.bitmap && 'close' in entry.bitmap) /** @type {ImageBitmap} */ (entry.bitmap).close();
      this.cache.delete(k);
    });
  }

  /**
   * Уровень детализации: размер текселя ≈ мягкость края.
   * @param {number} chunkPx @param {boolean} crisp
   */
  levelFor(chunkPx, crisp) {
    const target = crisp ? chunkPx : chunkPx / 5;
    return LEVELS.find((l) => l >= target) || 256;
  }

  draw() {
    this.frame = 0;
    const t0 = performance.now();
    const rect = this.resize();
    const dpr = this.dpr;
    const W = rect.width;
    const H = rect.height;
    const theme = this.getTheme();
    const mode = this.getMode();
    const settings = this.getSettings();
    const ctx = this.ctx;
    const mctx = this.mctx;
    const crisp = theme === 'heroes' || mode === 'hex';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.clearRect(0, 0, W, H);

    // ---- маска открытого ----
    const bounds = this.view.getBounds();
    const chunks = this.source.chunksInBounds(bounds);
    const now = Date.now();
    let chunkPx = 0;
    if (mode === 'hex') {
      this.drawHexMask(W, H, settings.hexMeters);
    } else {
      mctx.imageSmoothingEnabled = !crisp;
      const base = mode === 'heroes4' ? 0.45 : mode === 'moba' ? 0.3 : 1;
      const first = chunks[0];
      const firstPx = first
        ? this.view.project(this.fog.chunkBounds(first).south, this.fog.chunkBounds(first).east).x -
          this.view.project(this.fog.chunkBounds(first).north, this.fog.chunkBounds(first).west).x
        : 0;
      // На мелких масштабах чанки склеиваются в кэшируемые мозаики 16×16:
      // вместо сотни drawImage за кадр — несколько.
      const useMosaic = !crisp && mode !== 'redalert' && firstPx > 0 && firstPx < MOSAIC_MAX_PX;
      // бикубика ('high') на сотнях уменьшенных масок дороже кадра; билинейной хватает
      mctx.imageSmoothingQuality = 'low';
      if (useMosaic) {
        chunkPx = firstPx;
        mctx.globalAlpha = base;
        this.drawMosaics(chunks, mctx);
      }
      (useMosaic ? [] : chunks).forEach((chunk) => {
        const b = this.fog.chunkBounds(chunk);
        const nw = this.view.project(b.north, b.west);
        const se = this.view.project(b.south, b.east);
        chunkPx = Math.max(chunkPx, se.x - nw.x);
        const level = this.levelFor(se.x - nw.x, crisp);
        const img = this.maskImage(chunk, level, this.cache);
        if (!img) return;
        let alpha = base;
        if (mode === 'redalert' && chunk.visited) {
          const age = (now - chunk.visited) / (settings.regrowDays * 86400000);
          alpha = Math.max(0.12, 1 - age);
        }
        mctx.globalAlpha = alpha;
        mctx.drawImage(img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      });
      mctx.globalAlpha = 1;
      if (mode === 'heroes4' || mode === 'moba') this.drawVision(chunks, mode, settings, crisp);
    }
    this.drawSpots(theme, mctx);

    // ---- пелена ----
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = FOG_COLORS[/** @type {'terra'} */ (theme)] || FOG_COLORS.terra;
    ctx.fillRect(0, 0, W, H);
    this.drawTexture(theme, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mask, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    if (theme === 'western' && mode !== 'hex') this.drawRim(W, H, dpr);
    this.drawChoropleth(ctx);

    if (this.fade) {
      const k = (performance.now() - this.fade.start) / 450;
      if (k >= 1) this.fade = null;
      else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1 - k;
        ctx.drawImage(this.fade.canvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    this.drawOverlay(chunks, settings, W, H, dpr);
    this.trimCache();

    const ms = performance.now() - t0;
    this.stats = {
      frameMs: ms,
      avgMs: this.stats.avgMs ? this.stats.avgMs * 0.9 + ms * 0.1 : ms,
      chunks: chunks.length,
      cache: this.cache.size,
      pending: [...this.cache.values()].filter((e) => e.pending).length,
      draws: this.stats.draws + 1
    };
    this.dirty = false;
    if (this.spots.length || this.fade) this.requestDraw();
  }

  /** Гексы: гекс открыт, если открыта клетка в его центре. @param {number} W @param {number} H @param {number} hexMeters */
  drawHexMask(W, H, hexMeters) {
    const center = this.view.getCenter();
    const r = this.view.metersToPixels(center.lat, hexMeters / 2);
    if (r < 3) return;
    const mctx = this.mctx;
    const zoom = 22;
    const metersPerCellZ = (40075016.686 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom;
    const sizeCells = hexMeters / 2 / metersPerCellZ;
    const w = Math.sqrt(3) * sizeCells;
    const hgt = 1.5 * sizeCells;
    const b = this.view.getBounds();
    const nw = project(b.north, b.west, zoom);
    const se = project(b.south, b.east, zoom);
    mctx.fillStyle = '#fff';
    mctx.beginPath();
    for (let row = Math.floor(nw.y / hgt) - 1; row <= Math.ceil(se.y / hgt) + 1; row += 1) {
      for (let col = Math.floor(nw.x / w) - 1; col <= Math.ceil(se.x / w) + 1; col += 1) {
        const cx = col * w + (row & 1 ? w / 2 : 0);
        const cy = row * hgt;
        if (!this.source.isCellRevealed(Math.floor(cx), Math.floor(cy))) continue;
        const ll = unproject(cx, cy, zoom);
        const p = this.view.project(ll.lat, ll.lng);
        for (let k = 0; k < 6; k += 1) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          const x = p.x + r * 1.02 * Math.cos(a);
          const y = p.y + r * 1.02 * Math.sin(a);
          if (k === 0) mctx.moveTo(x, y);
          else mctx.lineTo(x, y);
        }
        mctx.closePath();
      }
    }
    mctx.fill();
    // тонкие грани гексов на открытом
    mctx.globalCompositeOperation = 'destination-out';
    mctx.strokeStyle = 'rgba(0,0,0,.18)';
    mctx.lineWidth = 1;
    mctx.stroke();
    mctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Обзор: Heroes IV — открытое вне радиуса приглушено; MOBA — круги от путешественника и меток.
   * @param {Chunk[]} chunks @param {string} mode @param {any} settings @param {boolean} crisp
   */
  drawVision(chunks, mode, settings, crisp) {
    const vctx = this.vctx;
    const dpr = this.dpr;
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    vctx.clearRect(0, 0, this.width, this.height);
    const sources = mode === 'moba' ? [this.player, ...this.wards] : [this.player];
    sources.forEach((s) => {
      const p = this.view.project(s.lat, s.lng);
      const r = this.view.metersToPixels(s.lat, settings.visionMeters);
      const g = vctx.createRadialGradient(p.x, p.y, r * 0.75, p.x, p.y, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      vctx.fillStyle = g;
      vctx.beginPath();
      vctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      vctx.fill();
    });
    if (mode === 'heroes4') {
      // видно только разведанное: пересечение обзора с маской открытого
      vctx.globalCompositeOperation = 'destination-in';
      vctx.imageSmoothingEnabled = !crisp;
      chunks.forEach((chunk) => {
        const b = this.fog.chunkBounds(chunk);
        const nw = this.view.project(b.north, b.west);
        const se = this.view.project(b.south, b.east);
        const img = this.maskImage(chunk, this.levelFor(se.x - nw.x, crisp), this.cache);
        if (img) vctx.drawImage(img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      });
      vctx.globalCompositeOperation = 'source-over';
    }
    this.mctx.setTransform(1, 0, 0, 1, 0, 0);
    this.mctx.drawImage(this.vision, 0, 0);
    this.mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Анимации проявления новых клеток. @param {string} theme @param {CanvasRenderingContext2D} m */
  drawSpots(theme, m) {
    const now = performance.now();
    for (let i = this.spots.length - 1; i >= 0; i -= 1) {
      const spot = this.spots[i];
      const p = this.view.project(spot.lat, spot.lng);
      const radius = Math.max(4, this.view.metersToPixels(spot.lat, spot.radius));
      const progress = Math.min(1, (now - spot.createdAt) / spot.duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      if (progress >= 1) {
        spot.cells.forEach((cell) => cell.chunk.show(cell.index));
        this.spots.splice(i, 1);
      }
      if (theme === 'heroes') drawHeroesReveal(m, p, radius, eased);
      else drawSoftReveal(m, p, radius, eased, spot.id, theme === 'western' ? 0.26 : 0.16);
    }
  }

  /** @param {string} theme @param {number} W @param {number} H */
  drawTexture(theme, W, H) {
    const ctx = this.ctx;
    if (theme === 'heroes') {
      ctx.strokeStyle = 'rgba(107, 84, 37, .16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < W; x += 34) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = 0; y < H; y += 34) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
    } else if (theme === 'western') {
      ctx.fillStyle = 'rgba(255, 241, 207, .2)';
      for (let y = 0; y < H; y += 9) ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = 'rgba(91, 56, 30, .1)';
      for (let x = 0; x < W; x += 17) ctx.fillRect(x, 0, 1, H);
      const v = ctx.createRadialGradient(W / 2, H / 2, W * 0.12, W / 2, H / 2, W * 0.75);
      v.addColorStop(0, 'rgba(255,255,255,0)');
      v.addColorStop(1, 'rgba(88,49,24,.22)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Чернильная кайма по краю открытого (Red Dead): тень маски минус сама маска.
   * @param {number} W @param {number} H @param {number} dpr
   */
  drawRim(W, H, dpr) {
    const r = this.rctx;
    r.setTransform(1, 0, 0, 1, 0, 0);
    r.clearRect(0, 0, this.width, this.height);
    r.shadowColor = 'rgba(58, 42, 28, .85)';
    r.shadowBlur = 3 * dpr;
    r.drawImage(this.mask, 0, 0);
    r.shadowBlur = 0;
    r.globalCompositeOperation = 'destination-out';
    r.drawImage(this.mask, 0, 0);
    r.globalCompositeOperation = 'source-over';
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.rim, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    void W;
    void H;
  }

  /** Хороплет районов поверх пелены: заливка по доле открытого. @param {CanvasRenderingContext2D} o */
  drawChoropleth(o) {
    if (!this.choropleth.length) return;
    {
      o.lineWidth = 1.2;
      this.choropleth.forEach((district) => {
        o.beginPath();
        district.polygon.forEach((poly) =>
          poly.forEach((ring) =>
            ring.forEach(([lng, lat], i) => {
              const p = this.view.project(lat, lng);
              if (i === 0) o.moveTo(p.x, p.y);
              else o.lineTo(p.x, p.y);
            })
          )
        );
        const k = Math.min(1, district.ratio * 4);
        o.fillStyle = `rgba(${Math.round(80 + 165 * k)}, ${Math.round(120 + 48 * (1 - k))}, ${Math.round(160 - 120 * k)}, .28)`;
        o.fill('evenodd');
        o.strokeStyle = 'rgba(245, 168, 102, .75)';
        o.stroke();
      });
    }
  }

  /**
   * Нижний слой: тепловая карта, сравнение с другом, трек.
   * @param {Chunk[]} chunks @param {any} settings @param {number} W @param {number} H @param {number} dpr
   */
  drawOverlay(chunks, settings, W, H, dpr) {
    const o = this.octx;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    if (settings.showHeat) {
      o.imageSmoothingEnabled = false;
      o.globalAlpha = 0.7;
      chunks.forEach((chunk) => {
        const b = this.fog.chunkBounds(chunk);
        const nw = this.view.project(b.north, b.west);
        const se = this.view.project(b.south, b.east);
        const img = this.heatImage(chunk);
        if (img) o.drawImage(img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
      });
      o.globalAlpha = 1;
    }
    if (this.compare) {
      const bounds = this.view.getBounds();
      o.imageSmoothingEnabled = true;
      this.compare.chunksInBounds(bounds).forEach((chunk) => {
        const b = this.fog.chunkBounds(chunk);
        const nw = this.view.project(b.north, b.west);
        const se = this.view.project(b.south, b.east);
        const img = this.maskImage(chunk, this.levelFor(se.x - nw.x, false), this.compareCache, false);
        if (!img) return;
        o.save();
        o.globalAlpha = 0.45;
        o.drawImage(img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
        o.globalCompositeOperation = 'source-atop';
        o.fillStyle = '#3b82f6';
        o.fillRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
        o.restore();
      });
    }
    if (settings.showTrack) {
      o.strokeStyle = 'rgba(220, 90, 40, .85)';
      o.lineWidth = 2.5;
      o.lineJoin = 'round';
      o.lineCap = 'round';
      o.beginPath();
      const b = this.view.getBounds();
      const pad = (b.north - b.south) * 0.2;
      this.getTracks().forEach((seg) => {
        let started = false;
        seg.forEach((pt) => {
          const inside = pt.lat < b.north + pad && pt.lat > b.south - pad && pt.lng > b.west - pad && pt.lng < b.east + pad;
          if (!inside) {
            started = false;
            return;
          }
          const p = this.view.project(pt.lat, pt.lng);
          if (!started) o.moveTo(p.x, p.y);
          else o.lineTo(p.x, p.y);
          started = true;
        });
      });
      o.stroke();
    }
  }

  /**
   * Сборка картинки «моя карта»: подложка + overlay + пелена + путешественник.
   * @param {string} filter @param {string} title
   */
  compose(filter, title) {
    const rect = this.viewport.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(rect.width * this.dpr);
    out.height = Math.round(rect.height * this.dpr);
    const c = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d'));
    c.scale(this.dpr, this.dpr);
    c.fillStyle = '#ddd';
    c.fillRect(0, 0, rect.width, rect.height);
    this.view.drawBasemap(c, rect, filter);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.overlay, 0, 0);
    c.drawImage(this.canvas, 0, 0);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const p = this.view.project(this.player.lat, this.player.lng);
    c.fillStyle = '#dc8650';
    c.strokeStyle = '#fff0d0';
    c.lineWidth = 3;
    c.beginPath();
    c.arc(p.x, p.y, 9, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.fillStyle = 'rgba(11,19,32,.8)';
    c.fillRect(0, rect.height - 26, rect.width, 26);
    c.fillStyle = '#edf3ec';
    c.font = '12px sans-serif';
    c.fillText(title, 10, rect.height - 9);
    c.textAlign = 'right';
    c.fillText('© OpenStreetMap contributors', rect.width - 10, rect.height - 9);
    return out;
  }
}

/**
 * Северо-западный угол чанка (cx, cy) зума CHUNK_ZOOM как [lat, lng].
 * @param {number} cx @param {number} cy @returns {[number, number]}
 */
function latLngOf(cx, cy) {
  const n = Math.PI - (2 * Math.PI * cy) / 2 ** 14;
  return [(180 / Math.PI) * Math.atan(Math.sinh(n)), (cx / 2 ** 14) * 360 - 180];
}

/** @param {Uint8ClampedArray} pixels @param {number} size */
function toCanvas(pixels, size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).putImageData(new ImageData(/** @type {any} */ (pixels), size, size), 0, 0);
  return c;
}

/** @param {string} seed @param {number} index */
function seededNoise(seed, index) {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) value = (value * 31 + seed.charCodeAt(i) + index * 17) % 9973;
  return (Math.sin(value) + 1) / 2;
}

/**
 * Мягкое проявление с рваным краем (Terra, Red Dead).
 * @param {CanvasRenderingContext2D} m @param {{x: number, y: number}} p @param {number} radius
 * @param {number} progress @param {string} seed @param {number} variance
 */
function drawSoftReveal(m, p, radius, progress, seed, variance) {
  const points = 34;
  m.save();
  m.beginPath();
  for (let i = 0; i <= points; i += 1) {
    const angle = (Math.PI * 2 * i) / points;
    const wave = Math.sin(angle * 3 + seededNoise(seed, i + 100) * Math.PI) * variance;
    const edge = 1 - variance + seededNoise(seed, i) * variance + wave;
    const r = radius * edge * (0.18 + progress * 0.82);
    const x = p.x + Math.cos(angle) * r;
    const y = p.y + Math.sin(angle) * r;
    if (i === 0) m.moveTo(x, y);
    else m.lineTo(x, y);
  }
  m.closePath();
  m.clip();
  const g = m.createRadialGradient(p.x, p.y, radius * 0.3 * progress, p.x, p.y, radius * progress);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.6, 'rgba(255,255,255,.94)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  m.fillStyle = g;
  m.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
  m.restore();
}

/**
 * Проявление Heroes: клетки открываются кольцами.
 * @param {CanvasRenderingContext2D} m @param {{x: number, y: number}} p @param {number} radius @param {number} progress
 */
function drawHeroesReveal(m, p, radius, progress) {
  const tile = Math.max(8, radius / 2.25);
  const maxD = Math.max(2, Math.ceil(radius / tile));
  m.fillStyle = '#fff';
  for (let row = -maxD; row <= maxD; row += 1) {
    for (let col = -maxD; col <= maxD; col += 1) {
      const d = Math.abs(row) + Math.abs(col) * 0.9;
      const noise = seededNoise(`${row}:${col}`, 3) > 0.42 ? 0.75 : 0;
      if (d <= maxD + noise && progress * (maxD + 1.8) >= d * 0.72) {
        const x = Math.round((p.x + col * tile) / tile) * tile;
        const y = Math.round((p.y + row * tile) / tile) * tile;
        m.fillRect(x - tile / 2, y - tile / 2, tile - 1, tile - 1);
      }
    }
  }
}
