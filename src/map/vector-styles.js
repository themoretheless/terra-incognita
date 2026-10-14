// @ts-check
/**
 * Палитры векторных стилей по темам (из дизайн-канваса, design/canvas/project/Spec.dc.html)
 * и перекраска стиля MapLibre: каждому слою по его id и типу подбирается цвет темы.
 */

/**
 * @typedef {{ background: string, water: string, waterLine: string, park: string, landuse: string,
 *   building: string, buildingLine: string, roadMajor: string, roadMinor: string, roadCase: string,
 *   rail: string, text: string, halo: string, boundary: string }} Palette
 */

/** @type {Record<string, Palette>} */
export const THEME_PALETTES = {
  western: {
    background: '#e7d6b1',
    water: '#c5cfc0',
    waterLine: '#56634f',
    park: '#d6d0a0',
    landuse: '#ddc9a0',
    building: '#d6c39a',
    buildingLine: '#5a4630',
    roadMajor: '#e2d0aa',
    roadMinor: '#cdb98e',
    roadCase: '#3a2a1c',
    rail: '#3a2a1c',
    text: '#2f2214',
    halo: '#e7d6b1',
    boundary: '#8a6a44'
  },
  heroes: {
    background: '#5a9234',
    water: '#2b5d9e',
    waterLine: '#1a4478',
    park: '#467a25',
    landuse: '#4f8a2c',
    building: '#8e7d68',
    buildingLine: '#4e4032',
    roadMajor: '#a3854f',
    roadMinor: '#8b6b3e',
    roadCase: '#6a4e2e',
    rail: '#46464c',
    text: '#fff3c9',
    halo: '#2a1a0e',
    boundary: '#e5b84f'
  },
  terra: {
    background: '#18222c',
    water: '#0f2a3a',
    waterLine: '#1d4a63',
    park: '#1c3329',
    landuse: '#1d2731',
    building: '#26313b',
    buildingLine: '#33414c',
    roadMajor: '#5a4a38',
    roadMinor: '#2f3a44',
    roadCase: '#121a22',
    rail: '#475563',
    text: '#d7e1d7',
    halo: '#0b1320',
    boundary: '#f5a866'
  }
};

/** Ночная версия палитры: темнее и холоднее. @param {Palette} p @returns {Palette} */
export function nightPalette(p) {
  /** @type {any} */
  const out = {};
  Object.entries(p).forEach(([k, v]) => {
    out[k] = k === 'text' || k === 'boundary' ? v : shade(v, -0.45, 0.12);
  });
  return out;
}

/**
 * Затемнение и сдвиг в синий.
 * @param {string} hex @param {number} amount @param {number} blue
 */
export function shade(hex, amount, blue) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(r * (1 + amount));
  g = Math.round(g * (1 + amount));
  b = Math.round(Math.min(255, b * (1 + amount) + 255 * blue * 0.3));
  return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Цвет для слоя по его id.
 * @param {string} id @param {string} type @param {Palette} p
 * @returns {string | null}
 */
export function colorForLayer(id, type, p) {
  const s = id.toLowerCase();
  if (type === 'background') return p.background;
  if (/water|ocean|river|lake/.test(s)) return type === 'line' ? p.waterLine : p.water;
  if (/park|grass|wood|forest|landcover|cemetery|pitch|garden|wetland|scrub/.test(s)) return p.park;
  if (/building/.test(s)) return type === 'line' ? p.buildingLine : p.building;
  if (/rail|transit/.test(s)) return p.rail;
  if (/casing|case/.test(s)) return p.roadCase;
  if (/motorway|trunk|primary|secondary/.test(s)) return p.roadMajor;
  if (/road|street|highway|tertiary|minor|service|path|track|bridge|tunnel|pedestrian|aeroway/.test(s)) return p.roadMinor;
  if (/boundary|admin/.test(s)) return p.boundary;
  if (/landuse|residential|industrial|commercial|place/.test(s)) return p.landuse;
  return null;
}

/**
 * Возвращает копию стиля, перекрашенную в палитру темы.
 * @param {any} style @param {Palette} palette @param {boolean} night
 */
export function recolorStyle(style, palette, night) {
  const p = night ? nightPalette(palette) : palette;
  const copy = JSON.parse(JSON.stringify(style));
  copy.layers = copy.layers.map((/** @type {any} */ layer) => {
    const paint = layer.paint || {};
    const color = colorForLayer(layer.id, layer.type, p);
    if (layer.type === 'background') paint['background-color'] = p.background;
    else if (layer.type === 'fill' && color) {
      paint['fill-color'] = color;
      if (paint['fill-pattern']) delete paint['fill-pattern'];
      if (/building/.test(layer.id)) paint['fill-outline-color'] = p.buildingLine;
    } else if (layer.type === 'fill-extrusion' && color) paint['fill-extrusion-color'] = color;
    else if (layer.type === 'line' && color) paint['line-color'] = color;
    else if (layer.type === 'symbol') {
      paint['text-color'] = p.text;
      paint['text-halo-color'] = p.halo;
      paint['icon-opacity'] = 0.85;
    }
    layer.paint = paint;
    return layer;
  });
  return copy;
}
