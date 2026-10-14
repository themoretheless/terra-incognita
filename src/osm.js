// @ts-check
/**
 * Данные OpenStreetMap через Overpass API: интересные места, административные
 * границы и улицы. Ответы кэшируются в localStorage на неделю.
 */
import { pointInMultiPolygon, multiPolygonBounds, multiPolygonArea, densify } from './geo.js';

export const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const CACHE_PREFIX = 'terra-osm:';
const CACHE_TTL = 7 * 86400000;

/**
 * Запрос к Overpass с перебором зеркал и кэшем.
 * @param {string} query @param {{ cacheKey?: string, fetchImpl?: typeof fetch, storage?: Storage | null }} [options]
 */
export async function overpass(query, options = {}) {
  const storage = options.storage === undefined ? globalThis.localStorage || null : options.storage;
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const key = CACHE_PREFIX + (options.cacheKey || query);
  if (storage) {
    try {
      const cached = JSON.parse(storage.getItem(key) || 'null');
      if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;
    } catch (error) {
      /* битый кэш — запросим заново */
    }
  }
  let lastError = /** @type {any} */ (null);
  for (const url of OVERPASS_MIRRORS) {
    try {
      const response = await fetchImpl(url, { method: 'POST', body: new URLSearchParams({ data: query }) });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const data = await response.json();
      if (storage) {
        try {
          storage.setItem(key, JSON.stringify({ t: Date.now(), data }));
        } catch (error) {
          /* кэш не влез — не страшно */
        }
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Overpass недоступен');
}

/** @typedef {{ id: string, lat: number, lng: number, name: string, kind: string, discovered: boolean }} Poi */

const POI_KINDS = [
  ['tourism', 'attraction|museum|viewpoint|artwork|gallery'],
  ['historic', 'monument|memorial|castle|ruins|fort|archaeological_site'],
  ['amenity', 'place_of_worship|fountain|theatre|library'],
  ['man_made', 'bridge|tower|lighthouse|windmill'],
  ['leisure', 'park|garden']
];

/**
 * Интересные места вокруг точки.
 * @param {number} lat @param {number} lng @param {number} radiusMeters @param {Parameters<typeof overpass>[1]} [options]
 * @returns {Promise<Poi[]>}
 */
export async function fetchPois(lat, lng, radiusMeters, options) {
  const around = `(around:${Math.round(radiusMeters)},${lat.toFixed(5)},${lng.toFixed(5)})`;
  const parts = POI_KINDS.map(([k, v]) => `nwr["${k}"~"^(${v})$"]["name"]${around};`).join('');
  const query = `[out:json][timeout:25];(${parts});out center 60;`;
  const data = await overpass(query, { ...options, cacheKey: `pois:${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(radiusMeters)}` });
  /** @type {Poi[]} */
  const pois = [];
  (data.elements || []).forEach((/** @type {any} */ e) => {
    const p = e.type === 'node' ? { lat: e.lat, lng: e.lon } : e.center ? { lat: e.center.lat, lng: e.center.lon } : null;
    if (!p || !e.tags || !e.tags.name) return;
    const kind = POI_KINDS.map(([k]) => (e.tags[k] ? `${k}:${e.tags[k]}` : '')).find(Boolean) || 'place';
    pois.push({ id: `${e.type}/${e.id}`, lat: p.lat, lng: p.lng, name: e.tags.name, kind, discovered: false });
  });
  return pois;
}

/**
 * Сборка колец из отрезков (членов отношения).
 * @param {Array<Array<[number, number]>>} segments
 */
export function assembleRings(segments) {
  const segs = segments.filter((s) => s.length > 1).map((s) => s.slice());
  /** @type {Array<Array<[number, number]>>} */
  const rings = [];
  const same = (/** @type {[number, number]} */ a, /** @type {[number, number]} */ b) => a[0] === b[0] && a[1] === b[1];
  while (segs.length) {
    let ring = /** @type {Array<[number, number]>} */ (segs.pop());
    let changed = true;
    while (changed && !same(ring[0], ring[ring.length - 1])) {
      changed = false;
      for (let i = 0; i < segs.length; i += 1) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        const start = ring[0];
        if (same(s[0], end)) ring = ring.concat(s.slice(1));
        else if (same(s[s.length - 1], end)) ring = ring.concat(s.slice(0, -1).reverse());
        else if (same(s[s.length - 1], start)) ring = s.slice(0, -1).concat(ring);
        else if (same(s[0], start)) ring = s.slice(1).reverse().concat(ring);
        else continue;
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

/**
 * Отношение-полигон Overpass (out geom) → мультиполигон GeoJSON.
 * @param {any} relation
 * @returns {Array<Array<Array<[number, number]>>>}
 */
export function relationToMultiPolygon(relation) {
  /** @param {any} m @returns {Array<[number, number]>} */
  const coords = (m) => (m.geometry || []).map((/** @type {any} */ g) => [g.lon, g.lat]);
  const ways = (relation.members || []).filter((/** @type {any} */ m) => m.type === 'way');
  const outers = assembleRings(ways.filter((/** @type {any} */ m) => m.role !== 'inner').map(coords));
  const inners = assembleRings(ways.filter((/** @type {any} */ m) => m.role === 'inner').map(coords));
  /** @type {Array<Array<Array<[number, number]>>>} */
  const polygons = outers.map((ring) => [ring]);
  inners.forEach((hole) => {
    const [lng, lat] = hole[0];
    const owner = polygons.find((poly) => pointInMultiPolygon(lat, lng, [[poly[0]]]));
    if (owner) owner.push(hole);
  });
  return polygons;
}

/**
 * @typedef {{ id: string, name: string, level: number, polygon: Array<Array<Array<[number, number]>>>, area: number, bounds: import('./geo.js').Bounds }} Area
 */

/**
 * Административные границы, в которые попадает точка (район, город…).
 * @param {number} lat @param {number} lng @param {Parameters<typeof overpass>[1]} [options]
 * @returns {Promise<Area[]>}
 */
export async function fetchAreasAt(lat, lng, options) {
  const query = `[out:json][timeout:30];is_in(${lat.toFixed(5)},${lng.toFixed(5)})->.a;rel(pivot.a)["boundary"="administrative"]["admin_level"~"^(6|7|8|9|10)$"];out geom;`;
  const data = await overpass(query, { ...options, cacheKey: `areas:${lat.toFixed(3)},${lng.toFixed(3)}` });
  return (data.elements || [])
    .filter((/** @type {any} */ e) => e.type === 'relation')
    .map((/** @type {any} */ e) => {
      const polygon = relationToMultiPolygon(e);
      return {
        id: `relation/${e.id}`,
        name: (e.tags && (e.tags.name || e.tags['name:en'])) || `#${e.id}`,
        level: Number(e.tags && e.tags.admin_level) || 0,
        polygon,
        area: multiPolygonArea(polygon),
        bounds: multiPolygonBounds(polygon)
      };
    })
    .filter((/** @type {Area} */ a) => a.polygon.length && pointInMultiPolygon(lat, lng, a.polygon))
    .sort((/** @type {Area} */ a, /** @type {Area} */ b) => b.level - a.level);
}

/**
 * Районы (дочерние границы) внутри прямоугольника — для хороплета.
 * @param {import('./geo.js').Bounds} b @param {number} level @param {Parameters<typeof overpass>[1]} [options]
 * @returns {Promise<Area[]>}
 */
export async function fetchAreasIn(b, level, options) {
  const bbox = `${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`;
  const query = `[out:json][timeout:40];rel["boundary"="administrative"]["admin_level"="${level}"](${bbox});out geom;`;
  const data = await overpass(query, { ...options, cacheKey: `areas-in:${level}:${bbox}` });
  return (data.elements || [])
    .filter((/** @type {any} */ e) => e.type === 'relation')
    .map((/** @type {any} */ e) => {
      const polygon = relationToMultiPolygon(e);
      return { id: `relation/${e.id}`, name: (e.tags && e.tags.name) || `#${e.id}`, level, polygon, area: multiPolygonArea(polygon), bounds: multiPolygonBounds(polygon) };
    })
    .filter((/** @type {Area} */ a) => a.polygon.length);
}

/**
 * Улицы внутри области: точки вдоль осей с шагом stepMeters.
 * @param {Area} area @param {number} stepMeters @param {Parameters<typeof overpass>[1]} [options]
 * @returns {Promise<Array<{ name: string, points: Array<{lat: number, lng: number}> }>>}
 */
export async function fetchStreets(area, stepMeters, options) {
  const b = area.bounds;
  const bbox = `${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`;
  const query = `[out:json][timeout:60];way["highway"~"^(primary|secondary|tertiary|residential|living_street|pedestrian|unclassified)$"]["name"](${bbox});out geom;`;
  const data = await overpass(query, { ...options, cacheKey: `streets:${area.id}` });
  /** @type {Map<string, Array<{lat: number, lng: number}>>} */
  const byName = new Map();
  (data.elements || []).forEach((/** @type {any} */ e) => {
    if (!e.geometry || !e.tags) return;
    const pts = densify(
      e.geometry.map((/** @type {any} */ g) => ({ lat: g.lat, lng: g.lon })),
      stepMeters
    ).filter((p) => pointInMultiPolygon(p.lat, p.lng, area.polygon));
    if (!pts.length) return;
    const list = byName.get(e.tags.name) || [];
    byName.set(e.tags.name, list.concat(pts));
  });
  return [...byName.entries()].map(([name, points]) => ({ name, points }));
}
