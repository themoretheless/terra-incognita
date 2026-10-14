// @ts-check
/**
 * Геометрия: проекция Web Mercator, расстояния, полигоны.
 * Модуль без зависимостей от DOM, используется и в браузере, и в тестах Node.
 */

export const EARTH_CIRCUMFERENCE = 40075016.686;
export const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;

/**
 * @typedef {{ lat: number, lng: number }} LatLng
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ north: number, south: number, west: number, east: number }} Bounds
 */

/**
 * Широта/долгота → координаты тайловой сетки на зуме zoom (в тайлах, дробные).
 * @param {number} lat
 * @param {number} lng
 * @param {number} zoom
 * @returns {Point}
 */
export function project(lat, lng, zoom) {
  const scale = Math.pow(2, zoom);
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin(clamped * DEG);
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

/**
 * Обратная проекция.
 * @param {number} x
 * @param {number} y
 * @param {number} zoom
 * @returns {LatLng}
 */
export function unproject(x, y, zoom) {
  const scale = Math.pow(2, zoom);
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/**
 * Длина стороны тайла/клетки зума zoom на широте lat, в метрах.
 * @param {number} lat
 * @param {number} zoom
 */
export function metersPerTile(lat, zoom) {
  return (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) / Math.pow(2, zoom);
}

/** @param {number} meters */
export function metersToLatitude(meters) {
  return meters / 111320;
}

/** @param {number} meters @param {number} lat */
export function metersToLongitude(meters, lat) {
  return meters / (111320 * Math.max(0.01, Math.cos(lat * DEG)));
}

/**
 * Расстояние по большому кругу, метры.
 * @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2
 */
export function distance(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Азимут от точки 1 к точке 2, градусы 0..360 (0 — север).
 * @param {number} lat1 @param {number} lng1 @param {number} lat2 @param {number} lng2
 */
export function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin((lng2 - lng1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lng2 - lng1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/**
 * Точка на отрезке между двумя координатами (линейно — для коротких отрезков достаточно).
 * @param {LatLng} a @param {LatLng} b @param {number} t
 * @returns {LatLng}
 */
export function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/**
 * Разбивает ломаную на точки не реже чем через stepMeters.
 * @param {LatLng[]} points
 * @param {number} stepMeters
 * @returns {LatLng[]}
 */
export function densify(points, stepMeters) {
  if (points.length < 2) return points.slice();
  /** @type {LatLng[]} */
  const out = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const d = distance(a.lat, a.lng, b.lat, b.lng);
    const n = Math.max(1, Math.ceil(d / stepMeters));
    for (let k = 1; k <= n; k += 1) out.push(lerp(a, b, k / n));
  }
  return out;
}

/**
 * Точка внутри кольца (лучевой метод), кольцо — массив [lng, lat] или {lat,lng}.
 * @param {number} lat @param {number} lng
 * @param {Array<[number, number]>} ring  — [lng, lat]
 */
export function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Точка внутри полигона GeoJSON (внешнее кольцо + дыры).
 * @param {number} lat @param {number} lng
 * @param {Array<Array<[number, number]>>} polygon
 */
export function pointInPolygon(lat, lng, polygon) {
  if (!polygon.length || !pointInRing(lat, lng, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h += 1) if (pointInRing(lat, lng, polygon[h])) return false;
  return true;
}

/**
 * @param {number} lat @param {number} lng
 * @param {Array<Array<Array<[number, number]>>>} multipolygon
 */
export function pointInMultiPolygon(lat, lng, multipolygon) {
  return multipolygon.some((polygon) => pointInPolygon(lat, lng, polygon));
}

/**
 * Ограничивающий прямоугольник мультиполигона.
 * @param {Array<Array<Array<[number, number]>>>} multipolygon
 * @returns {Bounds}
 */
export function multiPolygonBounds(multipolygon) {
  let north = -90;
  let south = 90;
  let west = 180;
  let east = -180;
  multipolygon.forEach((polygon) =>
    polygon[0].forEach(([lng, lat]) => {
      north = Math.max(north, lat);
      south = Math.min(south, lat);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
    })
  );
  return { north, south, west, east };
}

/**
 * Площадь кольца [lng, lat] на сфере, м² (формула для сферического многоугольника).
 * @param {Array<[number, number]>} ring
 */
export function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % ring.length];
    area += (lng2 - lng1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return Math.abs((area * EARTH_RADIUS * EARTH_RADIUS) / 2);
}

/**
 * Площадь мультиполигона, м².
 * @param {Array<Array<Array<[number, number]>>>} multipolygon
 */
export function multiPolygonArea(multipolygon) {
  return multipolygon.reduce((sum, polygon) => sum + ringArea(polygon[0]) - polygon.slice(1).reduce((h, ring) => h + ringArea(ring), 0), 0);
}

/**
 * Время восхода и заката (UTC, мс) по упрощённому алгоритму NOAA.
 * @param {Date} date @param {number} lat @param {number} lng
 * @returns {{ sunrise: number, sunset: number } | null} null — полярный день/ночь
 */
export function sunTimes(date, lat, lng) {
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  const gamma = ((2 * Math.PI) / 365) * (day - 1);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const cosHa = Math.cos(90.833 * DEG) / (Math.cos(lat * DEG) * Math.cos(decl)) - Math.tan(lat * DEG) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null;
  const ha = Math.acos(cosHa) / DEG;
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const sunrise = midnight + (720 - 4 * (lng + ha) - eqtime) * 60000;
  const sunset = midnight + (720 - 4 * (lng - ha) - eqtime) * 60000;
  return { sunrise, sunset };
}

/**
 * Дата в формате YYYY-MM-DD по локальному времени.
 * @param {number | Date} [time]
 */
export function dayKey(time = Date.now()) {
  const d = new Date(time);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
