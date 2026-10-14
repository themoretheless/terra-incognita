// @ts-check
/**
 * Треки: запись пройденного пути по дням, импорт GPX/GeoJSON/KML, экспорт GPX.
 * Хранятся в IndexedDB (store `tracks`, ключ — день YYYY-MM-DD).
 * Без базы — в памяти (данные теряются при закрытии вкладки, как и сама карта).
 */
import { STORES, promisify, done } from './db.js';
import { dayKey, distance } from './geo.js';

/**
 * @typedef {{ t: number, lat: number, lng: number, acc?: number, src?: 'gps' | 'manual' | 'import' }} TrackPoint
 * @typedef {{ day: string, points: TrackPoint[], meters: number }} TrackDay
 */

export class TrackStore {
  /** @param {IDBDatabase | null} db */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, TrackDay>} */
    this.days = new Map();
    /** @type {TrackPoint | null} */
    this.last = null;
    this.saveTimer = /** @type {any} */ (null);
    /** @type {Set<string>} */
    this.dirty = new Set();
    this.ready = this.load();
  }

  async load() {
    if (!this.db) return this;
    const tx = this.db.transaction(STORES.tracks, 'readonly');
    /** @type {TrackDay[]} */
    const rows = await promisify(tx.objectStore(STORES.tracks).getAll());
    rows.forEach((row) => this.days.set(row.day, row));
    const lastDay = [...this.days.keys()].sort().pop();
    if (lastDay) {
      const pts = /** @type {TrackDay} */ (this.days.get(lastDay)).points;
      this.last = pts[pts.length - 1] || null;
    }
    return this;
  }

  /**
   * Добавляет точку; соседние дубли (< 1 м) отбрасывает.
   * @param {TrackPoint} point
   */
  add(point) {
    const day = dayKey(point.t);
    let entry = this.days.get(day);
    if (!entry) {
      entry = { day, points: [], meters: 0 };
      this.days.set(day, entry);
    }
    const prev = entry.points[entry.points.length - 1];
    if (prev) {
      const d = distance(prev.lat, prev.lng, point.lat, point.lng);
      if (d < 1) return false;
      entry.meters += d;
    }
    entry.points.push(point);
    this.last = point;
    this.dirty.add(day);
    this.scheduleSave();
    return true;
  }

  /** Разрыв трека (телепорт кликом, «вернуться к лагерю»): следующая точка не соединится с предыдущей. */
  breakSegment() {
    const day = dayKey();
    const entry = this.days.get(day);
    if (entry && entry.points.length) {
      const last = entry.points[entry.points.length - 1];
      entry.points.push({ ...last, t: Date.now(), src: last.src, acc: -1 });
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 2000);
  }

  async flush() {
    if (!this.db || !this.dirty.size) return;
    const days = [...this.dirty];
    this.dirty.clear();
    const tx = this.db.transaction(STORES.tracks, 'readwrite');
    days.forEach((day) => tx.objectStore(STORES.tracks).put(this.days.get(day)));
    await done(tx);
  }

  async clear() {
    this.days.clear();
    this.last = null;
    if (!this.db) return;
    const tx = this.db.transaction(STORES.tracks, 'readwrite');
    tx.objectStore(STORES.tracks).clear();
    await done(tx);
  }

  /** Сегменты трека дня (разрывы — точки с acc = -1). @param {string} day */
  segments(day) {
    const entry = this.days.get(day);
    if (!entry) return [];
    /** @type {TrackPoint[][]} */
    const out = [[]];
    entry.points.forEach((p) => {
      if (p.acc === -1) out.push([]);
      else out[out.length - 1].push(p);
    });
    return out.filter((s) => s.length > 1);
  }

  /** Все сегменты всех дней, по порядку. */
  allSegments() {
    return [...this.days.keys()].sort().flatMap((day) => this.segments(day));
  }

  totalMeters() {
    let sum = 0;
    this.days.forEach((d) => {
      sum += d.meters;
    });
    return sum;
  }
}

// ---------- форматы ----------

/**
 * Атрибут XML-тега по имени.
 * @param {string} tag @param {string} name
 */
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? m[1] : null;
}

/**
 * GPX: треки (trkpt), маршруты (rtept) и точки (wpt). Без DOM — работает и в Node.
 * @param {string} text
 * @returns {{ segments: TrackPoint[][], waypoints: Array<{lat: number, lng: number, name: string}> }}
 */
export function parseGPX(text) {
  /** @type {TrackPoint[][]} */
  const segments = [];
  const segRe = /<(trkseg|rte)\b[\s\S]*?<\/\1>/g;
  let seg;
  while ((seg = segRe.exec(text))) {
    /** @type {TrackPoint[]} */
    const points = [];
    const ptRe = /<(trkpt|rtept)\b([^>]*)>([\s\S]*?)<\/\1>|<(trkpt|rtept)\b([^>]*)\/>/g;
    let m;
    while ((m = ptRe.exec(seg[0]))) {
      const head = m[2] || m[5] || '';
      const body = m[3] || '';
      const lat = Number(attr(head, 'lat'));
      const lng = Number(attr(head, 'lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const time = body.match(/<time>([^<]+)<\/time>/);
      points.push({ lat, lng, t: time ? Date.parse(time[1]) || 0 : 0, src: 'import' });
    }
    if (points.length) segments.push(points);
  }
  /** @type {Array<{lat: number, lng: number, name: string}>} */
  const waypoints = [];
  const wptRe = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>|<wpt\b([^>]*)\/>/g;
  let w;
  while ((w = wptRe.exec(text))) {
    const head = w[1] || w[3] || '';
    const lat = Number(attr(head, 'lat'));
    const lng = Number(attr(head, 'lon'));
    const name = (w[2] || '').match(/<name>([^<]*)<\/name>/);
    if (Number.isFinite(lat) && Number.isFinite(lng)) waypoints.push({ lat, lng, name: name ? decodeXml(name[1]) : '' });
  }
  return { segments, waypoints };
}

/**
 * KML: LineString и Point (coordinates "lng,lat[,alt] ...").
 * @param {string} text
 */
export function parseKML(text) {
  /** @type {TrackPoint[][]} */
  const segments = [];
  /** @type {Array<{lat: number, lng: number, name: string}>} */
  const waypoints = [];
  const placemarkRe = /<Placemark\b[\s\S]*?<\/Placemark>/g;
  let pm;
  while ((pm = placemarkRe.exec(text))) {
    const name = pm[0].match(/<name>([^<]*)<\/name>/);
    const lineRe = /<(LineString|LinearRing)\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
    let line;
    while ((line = lineRe.exec(pm[0]))) segments.push(parseKmlCoords(line[2]));
    const point = pm[0].match(/<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/);
    if (point) {
      const [p] = parseKmlCoords(point[1]);
      if (p) waypoints.push({ lat: p.lat, lng: p.lng, name: name ? decodeXml(name[1]) : '' });
    }
    const track = pm[0].match(/<gx:Track\b[\s\S]*?<\/gx:Track>/);
    if (track) {
      /** @type {TrackPoint[]} */
      const pts = [];
      const coordRe = /<gx:coord>([^<]+)<\/gx:coord>/g;
      let c;
      while ((c = coordRe.exec(track[0]))) {
        const [lng, lat] = c[1].trim().split(/\s+/).map(Number);
        if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push({ lat, lng, t: 0, src: 'import' });
      }
      if (pts.length) segments.push(pts);
    }
  }
  return { segments: segments.filter((s) => s.length), waypoints };
}

/** @param {string} text @returns {TrackPoint[]} */
function parseKmlCoords(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((tuple) => tuple.split(',').map(Number))
    .filter(([lng, lat]) => Number.isFinite(lat) && Number.isFinite(lng))
    .map(([lng, lat]) => ({ lat, lng, t: 0, src: /** @type {'import'} */ ('import') }));
}

/**
 * GeoJSON: LineString, MultiLineString, Polygon (контур), Point.
 * @param {string | object} input
 */
export function parseGeoJSON(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  /** @type {TrackPoint[][]} */
  const segments = [];
  /** @type {Array<{lat: number, lng: number, name: string}>} */
  const waypoints = [];
  /** @type {Array<Array<[number, number]>>} */
  const polygons = [];
  /** @param {any} coords */
  const line = (coords) => coords.map((/** @type {number[]} */ [lng, lat]) => ({ lat, lng, t: 0, src: 'import' }));
  /** @param {any} geom @param {any} props */
  const visit = (geom, props) => {
    if (!geom) return;
    switch (geom.type) {
      case 'LineString':
        segments.push(line(geom.coordinates));
        break;
      case 'MultiLineString':
        geom.coordinates.forEach((/** @type {any} */ c) => segments.push(line(c)));
        break;
      case 'Polygon':
        polygons.push(geom.coordinates[0]);
        break;
      case 'MultiPolygon':
        geom.coordinates.forEach((/** @type {any} */ p) => polygons.push(p[0]));
        break;
      case 'Point':
        waypoints.push({ lat: geom.coordinates[1], lng: geom.coordinates[0], name: (props && (props.name || props.title)) || '' });
        break;
      case 'GeometryCollection':
        geom.geometries.forEach((/** @type {any} */ g) => visit(g, props));
        break;
      default:
    }
  };
  if (data.type === 'FeatureCollection') data.features.forEach((/** @type {any} */ f) => visit(f.geometry, f.properties));
  else if (data.type === 'Feature') visit(data.geometry, data.properties);
  else visit(data, null);
  return { segments: segments.filter((s) => s.length), waypoints, polygons };
}

/**
 * Определяет формат по содержимому и разбирает.
 * @param {string} name @param {string} text
 */
export function parseTrackFile(name, text) {
  const lower = name.toLowerCase();
  const head = text.trimStart().slice(0, 200);
  if (lower.endsWith('.gpx') || head.includes('<gpx')) return { kind: 'gpx', ...parseGPX(text), polygons: [] };
  if (lower.endsWith('.kml') || head.includes('<kml')) return { kind: 'kml', ...parseKML(text), polygons: [] };
  if (lower.endsWith('.geojson') || lower.endsWith('.json') || head.startsWith('{')) return { kind: 'geojson', ...parseGeoJSON(text) };
  throw new Error('Неизвестный формат трека: нужен GPX, KML или GeoJSON');
}

/** @param {string} s */
function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] || c);
}

/** @param {string} s */
function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|apos|quot);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' })[/** @type {'lt'} */ (e)]);
}

/**
 * GPX 1.1 из сегментов.
 * @param {TrackPoint[][]} segments @param {string} [name]
 */
export function toGPX(segments, name = 'Terra Incognita') {
  const segs = segments
    .map(
      (seg) =>
        `    <trkseg>\n${seg
          .map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">${p.t ? `<time>${new Date(p.t).toISOString()}</time>` : ''}</trkpt>`)
          .join('\n')}\n    </trkseg>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Terra Incognita" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name)}</name>
${segs}
  </trk>
</gpx>
`;
}
