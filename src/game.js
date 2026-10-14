// @ts-check
/**
 * Игровой слой: статистика по дням, опыт и уровни, достижения, цели,
 * испытания, покрытие районов и улиц, сравнение с другом.
 * Состояние — в localStorage (`terra-game`), сами клетки — в FogStore.
 */
import { dayKey, distance, bearing, project, unproject, pointInMultiPolygon, pointInRing } from './geo.js';
import { CELL_ZOOM, CHUNK_BITS, CHUNK_SIZE, CHUNK_ZOOM, parseChunkKey } from './fog-store.js';
import { POPCOUNT } from './codec.js';

const KEY = 'terra-game';

/**
 * @typedef {import('./fog-store.js').FogStore} FogStore
 * @typedef {import('./osm.js').Area} Area
 * @typedef {import('./osm.js').Poi} Poi
 * @typedef {{ id: string, icon: string, name: string, nameEn: string, test: (g: Game, ctx: any) => boolean }} Achievement
 */

/** @type {Achievement[]} */
export const ACHIEVEMENTS = [
  { id: 'first-steps', icon: '👣', name: 'Первые шаги', nameEn: 'First steps', test: (g) => g.state.xp >= 100 },
  { id: 'hectare', icon: '▣', name: 'Гектар', nameEn: 'One hectare', test: (_g, c) => c.area >= 10000 },
  { id: 'ten-hectares', icon: '◈', name: 'Десять гектаров', nameEn: 'Ten hectares', test: (_g, c) => c.area >= 100000 },
  { id: 'square-km', icon: '◆', name: 'Квадратный километр', nameEn: 'Square kilometre', test: (_g, c) => c.area >= 1e6 },
  { id: 'ten-km', icon: '✦', name: 'Десять км²', nameEn: 'Ten km²', test: (_g, c) => c.area >= 1e7 },
  { id: 'first-find', icon: '⌖', name: 'Первая находка', nameEn: 'First find', test: (g) => Object.keys(g.state.pois).length >= 1 },
  { id: 'collector', icon: '❖', name: 'Собиратель: 10 мест', nameEn: 'Collector: 10 places', test: (g) => Object.keys(g.state.pois).length >= 10 },
  { id: 'bridges', icon: '⌒', name: 'Три моста', nameEn: 'Three bridges', test: (g) => Object.values(g.state.pois).filter((p) => /bridge/.test(p.kind)).length >= 3 },
  { id: 'streak-3', icon: '☀', name: 'Три дня подряд', nameEn: 'Three-day streak', test: (g) => g.streak() >= 3 },
  { id: 'streak-7', icon: '☼', name: 'Неделя подряд', nameEn: 'Week streak', test: (g) => g.streak() >= 7 },
  { id: 'night-owl', icon: '☾', name: 'Ночной путник', nameEn: 'Night walker', test: (_g, c) => c.hour !== undefined && c.hour < 5 && c.added > 0 },
  { id: 'wanderer', icon: '✈', name: 'Странник: 10 чанков', nameEn: 'Wanderer: 10 chunks', test: (_g, c) => c.chunks >= 10 },
  { id: 'district-25', icon: '◔', name: 'Четверть района', nameEn: 'Quarter of a district', test: (_g, c) => c.coverage >= 0.25 },
  { id: 'district-50', icon: '◑', name: 'Полрайона', nameEn: 'Half a district', test: (_g, c) => c.coverage >= 0.5 }
];

/** Уровень по опыту: уровень n требует 100·(n−1)² опыта. @param {number} xp */
export function levelFor(xp) {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
  return { level, current: 100 * (level - 1) ** 2, next: 100 * level ** 2 };
}

export class Game {
  /** @param {Storage | null} [storage] */
  constructor(storage = globalThis.localStorage || null) {
    this.storage = storage;
    this.state = {
      /** @type {Record<string, number>} */ days: {},
      xp: 0,
      /** @type {Record<string, number>} */ achievements: {},
      /** @type {Record<string, {t: number, name: string, kind: string, day: string}>} */ pois: {},
      /** @type {null | { areaId: string, areaName: string, startCells: number, targetPercent: number, start: number, end: number, totalCells: number }} */ challenge: null
    };
    /** @type {Array<(a: Achievement) => void>} */
    this.onAchievement = [];
    this.load();
  }

  load() {
    if (!this.storage) return;
    try {
      Object.assign(this.state, JSON.parse(this.storage.getItem(KEY) || '{}'));
    } catch (error) {
      /* битое состояние — с нуля */
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(KEY, JSON.stringify(this.state));
    } catch (error) {
      /* нет места */
    }
  }

  reset() {
    this.state.days = {};
    this.state.xp = 0;
    this.state.achievements = {};
    this.state.pois = {};
    this.state.challenge = null;
    this.save();
  }

  /** @param {number} added @param {number} [now] */
  recordReveal(added, now = Date.now()) {
    const day = dayKey(now);
    this.state.days[day] = (this.state.days[day] || 0) + added;
    this.state.xp += added;
    this.save();
  }

  /** @param {Poi} poi @param {number} [now] */
  recordPoi(poi, now = Date.now()) {
    if (this.state.pois[poi.id]) return false;
    this.state.pois[poi.id] = { t: now, name: poi.name, kind: poi.kind, day: dayKey(now) };
    this.state.xp += 50;
    this.save();
    return true;
  }

  /** @param {number} [now] */
  today(now = Date.now()) {
    return this.state.days[dayKey(now)] || 0;
  }

  /** Клетки за последние 7 дней. @param {number} [now] */
  week(now = Date.now()) {
    let sum = 0;
    for (let i = 0; i < 7; i += 1) sum += this.state.days[dayKey(now - i * 86400000)] || 0;
    return sum;
  }

  /** Серия дней подряд с открытиями, включая сегодня или вчера. @param {number} [now] */
  streak(now = Date.now()) {
    let n = 0;
    let t = now;
    if (!this.state.days[dayKey(t)]) t -= 86400000;
    while (this.state.days[dayKey(t)]) {
      n += 1;
      t -= 86400000;
    }
    return n;
  }

  bestDay() {
    let best = { day: '', cells: 0 };
    Object.entries(this.state.days).forEach(([day, cells]) => {
      if (cells > best.cells) best = { day, cells };
    });
    return best;
  }

  /**
   * Проверка достижений; новые — в onAchievement.
   * @param {{ area: number, added?: number, hour?: number, chunks: number, coverage: number }} ctx
   */
  checkAchievements(ctx) {
    /** @type {Achievement[]} */
    const unlocked = [];
    ACHIEVEMENTS.forEach((a) => {
      if (this.state.achievements[a.id]) return;
      if (a.test(this, ctx)) {
        this.state.achievements[a.id] = Date.now();
        unlocked.push(a);
      }
    });
    if (unlocked.length) {
      this.save();
      unlocked.forEach((a) => this.onAchievement.forEach((fn) => fn(a)));
    }
    return unlocked;
  }

  /**
   * Журнал по дням: клетки, находки, километры.
   * @param {Map<string, {meters: number}>} trackDays
   */
  journal(trackDays) {
    const days = new Set([...Object.keys(this.state.days), ...trackDays.keys()]);
    return [...days]
      .sort()
      .reverse()
      .map((day) => ({
        day,
        cells: this.state.days[day] || 0,
        meters: (trackDays.get(day) || { meters: 0 }).meters,
        pois: Object.values(this.state.pois)
          .filter((p) => p.day === day)
          .map((p) => p.name)
      }));
  }

  /** @param {Area} area @param {number} currentCells @param {number} totalCells @param {number} targetPercent */
  startChallenge(area, currentCells, totalCells, targetPercent) {
    const start = Date.now();
    this.state.challenge = { areaId: area.id, areaName: area.name, startCells: currentCells, targetPercent, start, end: start + 7 * 86400000, totalCells };
    this.save();
  }

  /** @param {number} currentCells */
  challengeProgress(currentCells) {
    const c = this.state.challenge;
    if (!c) return null;
    const gained = ((currentCells - c.startCells) / Math.max(1, c.totalCells)) * 100;
    return { ...c, gained, done: gained >= c.targetPercent, expired: Date.now() > c.end };
  }
}

// ---------- расчёты по хранилищу ----------

/**
 * Покрытие мультиполигона открытыми клетками.
 * Чанки целиком внутри полигона учитываются по счётчику, пересекающие — поклеточно.
 * @param {FogStore} fog @param {Area} area
 */
export async function areaCoverage(fog, area) {
  await fog.ensureBounds(area.bounds);
  let revealed = 0;
  fog.keysInBounds(area.bounds).forEach((key) => {
    const chunk = fog.chunks.get(key);
    if (!chunk || !chunk.count) return;
    const b = fog.chunkBounds(chunk);
    const corners = [
      [b.north, b.west],
      [b.north, b.east],
      [b.south, b.west],
      [b.south, b.east]
    ];
    const allInside = corners.every(([lat, lng]) => pointInMultiPolygon(lat, lng, area.polygon));
    const vertexInside = area.polygon.some((poly) => poly.some((ring) => ring.some(([lng, lat]) => lat < b.north && lat > b.south && lng > b.west && lng < b.east)));
    if (allInside && !vertexInside) {
      revealed += chunk.count;
      return;
    }
    const baseX = chunk.cx << CHUNK_BITS;
    const baseY = chunk.cy << CHUNK_BITS;
    for (let i = 0; i < chunk.bits.length; i += 1) {
      const byte = chunk.bits[i];
      if (!byte) continue;
      for (let bit = 0; bit < 8; bit += 1) {
        if (!(byte & (1 << bit))) continue;
        const idx = (i << 3) | bit;
        const c = unproject(baseX + (idx & (CHUNK_SIZE - 1)) + 0.5, baseY + (idx >> CHUNK_BITS) + 0.5, CELL_ZOOM);
        if (pointInMultiPolygon(c.lat, c.lng, area.polygon)) revealed += 1;
      }
    }
  });
  const lat = (area.bounds.north + area.bounds.south) / 2;
  const cell = fog.metersPerCell(lat);
  const total = Math.max(1, Math.round(area.area / (cell * cell)));
  return { revealed, total, ratio: Math.min(1, revealed / total) };
}

/**
 * Доля пройденных улиц: точки вдоль осей, попавшие в открытые клетки.
 * @param {FogStore} fog @param {Array<{name: string, points: Array<{lat: number, lng: number}>}>} streets
 */
export async function streetCoverage(fog, streets) {
  const all = streets.flatMap((s) => s.points);
  if (!all.length) return { done: 0, total: 0, streets: [] };
  let north = -90;
  let south = 90;
  let west = 180;
  let east = -180;
  all.forEach((p) => {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  });
  await fog.ensureBounds({ north, south, west, east });
  const result = streets.map((s) => {
    const hit = s.points.filter((p) => fog.isRevealed(p.lat, p.lng) === true).length;
    return { name: s.name, ratio: hit / s.points.length };
  });
  const done = result.filter((r) => r.ratio >= 0.9).length;
  return { done, total: result.length, streets: result.sort((a, b) => b.ratio - a.ratio) };
}

/**
 * Ближайшая неразведанная точка: обход кольцами вокруг путешественника.
 * @param {FogStore} fog @param {number} lat @param {number} lng @param {number} stepMeters @param {number} maxMeters
 */
export function nearestUnexplored(fog, lat, lng, stepMeters, maxMeters) {
  for (let r = stepMeters; r <= maxMeters; r += stepMeters) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / stepMeters));
    let best = null;
    for (let k = 0; k < n; k += 1) {
      const a = (2 * Math.PI * k) / n;
      const pLat = lat + (Math.cos(a) * r) / 111320;
      const pLng = lng + (Math.sin(a) * r) / (111320 * Math.cos((lat * Math.PI) / 180));
      if (fog.isRevealed(pLat, pLng) === false) {
        best = { lat: pLat, lng: pLng };
        break;
      }
    }
    if (best) return { ...best, distance: distance(lat, lng, best.lat, best.lng), bearing: bearing(lat, lng, best.lat, best.lng) };
  }
  return null;
}

/**
 * Ближайшая ненайденная цель.
 * @param {Poi[]} pois @param {number} lat @param {number} lng
 */
export function nextQuest(pois, lat, lng) {
  let best = null;
  pois.forEach((p) => {
    if (p.discovered) return;
    const d = distance(lat, lng, p.lat, p.lng);
    if (!best || d < best.distance) best = { poi: p, distance: d, bearing: bearing(lat, lng, p.lat, p.lng) };
  });
  return /** @type {null | {poi: Poi, distance: number, bearing: number}} */ (best);
}

/**
 * Сравнение двух хранилищ: только у меня, только у друга, у обоих (в клетках).
 * @param {FogStore} mine @param {FogStore} theirs
 */
export async function compareStores(mine, theirs) {
  await Promise.all([mine.loadAll(), theirs.loadAll()]);
  let onlyMine = 0;
  let onlyTheirs = 0;
  let both = 0;
  const keys = new Set([...mine.chunks.keys(), ...theirs.chunks.keys()]);
  keys.forEach((key) => {
    const a = mine.chunks.get(key);
    const b = theirs.chunks.get(key);
    for (let i = 0; i < 8192; i += 1) {
      const x = a ? a.bits[i] : 0;
      const y = b ? b.bits[i] : 0;
      if (!x && !y) continue;
      both += POPCOUNT[x & y];
      onlyMine += POPCOUNT[x & ~y & 0xff];
      onlyTheirs += POPCOUNT[y & ~x & 0xff];
    }
  });
  return { onlyMine, onlyTheirs, both };
}

/**
 * Временное хранилище для хроники: клетки открываются по трекам до указанного дня.
 * @param {typeof import('./fog-store.js').FogStore} FogStoreClass
 */
export function createReplayStore(FogStoreClass) {
  return new FogStoreClass({ factory: null, storage: null, broadcast: false, lruLimit: 4096 });
}

export { project, pointInRing, CHUNK_ZOOM, parseChunkKey };
