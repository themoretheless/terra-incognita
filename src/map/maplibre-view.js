// @ts-check
/**
 * Векторная подложка: MapLibre GL + тайлы OpenFreeMap (данные OpenStreetMap).
 * Стиль перекрашивается под тему: пергамент, Heroes, ночная Terra.
 * Включается флагом basemap = 'vector' в настройках; библиотека грузится по требованию.
 */
import { metersToLongitude } from '../geo.js';
import { loadScript, loadStyle } from '../util/load.js';
import { THEME_PALETTES, recolorStyle } from './vector-styles.js';

export const MAPLIBRE = {
  js: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  css: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  jsIntegrity: 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj',
  cssIntegrity: 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V'
};
export const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export class MapLibreView {
  /**
   * @param {HTMLElement} container
   * @param {{ lat: number, lng: number, zoom: number }} view
   * @param {string} theme
   */
  static async create(container, view, theme) {
    await Promise.all([loadStyle(MAPLIBRE.css, MAPLIBRE.cssIntegrity), loadScript(MAPLIBRE.js, MAPLIBRE.jsIntegrity)]);
    const response = await fetch(OPENFREEMAP_STYLE);
    if (!response.ok) throw new Error(`стиль карты недоступен (${response.status})`);
    const baseStyle = await response.json();
    return new MapLibreView(container, view, baseStyle, theme);
  }

  /**
   * @param {HTMLElement} container
   * @param {{ lat: number, lng: number, zoom: number }} view
   * @param {any} baseStyle
   * @param {string} theme
   */
  constructor(container, view, baseStyle, theme) {
    const maplibregl = /** @type {any} */ (globalThis).maplibregl;
    this.kind = 'vector';
    this.container = container;
    this.baseStyle = baseStyle;
    this.theme = theme;
    this.night = false;
    this.map = new maplibregl.Map({
      container,
      style: recolorStyle(baseStyle, THEME_PALETTES[theme] || THEME_PALETTES.terra, false),
      center: [view.lng, view.lat],
      zoom: view.zoom,
      attributionControl: false,
      preserveDrawingBuffer: true
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors, ODbL · © OpenMapTiles · OpenFreeMap' }));
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    this.map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: false }), 'top-right');
    /** @type {Record<string, Array<(e: any) => void>>} */
    this.handlers = {};
    this.map.on('move', () => this.emit('move'));
    this.map.on('zoomend', () => this.emit('zoom'));
    this.map.on('resize', () => this.emit('resize'));
    this.map.on('click', (/** @type {any} */ e) => this.emit('click', { lat: e.lngLat.lat, lng: e.lngLat.lng }));
    this.map.on('error', (/** @type {any} */ e) => {
      if (e && (e.tile || e.sourceId)) this.emit('tileerror');
    });
  }

  /** @param {string} name @param {(e: any) => void} fn */
  on(name, fn) {
    (this.handlers[name] ||= []).push(fn);
  }

  /** @param {string} name @param {any} [payload] */
  emit(name, payload) {
    (this.handlers[name] || []).forEach((fn) => fn(payload));
  }

  /** @param {number} lat @param {number} lng */
  project(lat, lng) {
    const p = this.map.project([lng, lat]);
    return { x: p.x, y: p.y };
  }

  getBounds() {
    const b = this.map.getBounds();
    return { north: b.getNorth(), south: b.getSouth(), west: b.getWest(), east: b.getEast() };
  }

  getZoom() {
    return this.map.getZoom();
  }

  getCenter() {
    const c = this.map.getCenter();
    return { lat: c.lat, lng: c.lng };
  }

  /** @param {number} lat @param {number} lng @param {number} [zoom] */
  setView(lat, lng, zoom) {
    this.map.jumpTo({ center: [lng, lat], zoom: zoom === undefined ? this.map.getZoom() : zoom });
  }

  /** @param {number} lat @param {number} lng */
  panTo(lat, lng) {
    this.map.easeTo({ center: [lng, lat], duration: 180 });
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
  }

  /** @param {number} lat @param {number} meters */
  metersToPixels(lat, meters) {
    const a = this.map.project([0, lat]);
    const b = this.map.project([metersToLongitude(meters, lat), lat]);
    return Math.abs(b.x - a.x);
  }

  /** Тема и ночь задаются перекраской стиля, а не CSS-фильтром. @param {string} theme @param {boolean} night */
  setTheme(theme, night) {
    if (theme === this.theme && night === this.night) return;
    this.theme = theme;
    this.night = night;
    this.map.setStyle(recolorStyle(this.baseStyle, THEME_PALETTES[theme] || THEME_PALETTES.terra, night));
  }

  /** @param {string} _filter */
  setFilter(_filter) {
    /* векторный стиль перекрашивается в setTheme */
  }

  invalidate() {
    this.map.resize();
  }

  /** @param {CanvasRenderingContext2D} ctx @param {DOMRect} _origin @param {string} _filter */
  drawBasemap(ctx, _origin, _filter) {
    const canvas = this.map.getCanvas();
    ctx.drawImage(canvas, 0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  destroy() {
    this.map.remove();
  }
}
