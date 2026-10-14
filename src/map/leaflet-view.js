// @ts-check
/**
 * Растровая подложка: Leaflet + тайлы OpenStreetMap.
 * Общий интерфейс MapView описан в map-view.js.
 */
import { metersToLongitude } from '../geo.js';

export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ODbL';

export class LeafletView {
  /**
   * @param {HTMLElement} container
   * @param {{ lat: number, lng: number, zoom: number }} view
   */
  constructor(container, view) {
    const Leaflet = /** @type {any} */ (globalThis).L;
    this.kind = 'raster';
    this.container = container;
    this.map = Leaflet.map(container, { zoomControl: false, attributionControl: true, zoomSnap: 0.5 }).setView([view.lat, view.lng], view.zoom);
    this.map.attributionControl.setPrefix(false);
    this.tiles = Leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: 'anonymous',
      attribution: OSM_ATTRIBUTION
    }).addTo(this.map);
    this.scale = Leaflet.control.scale({ position: 'bottomright', imperial: false }).addTo(this.map);
    /** @type {Record<string, Array<(e: any) => void>>} */
    this.handlers = {};
    this.tileErrors = [];
    this.tiles.on('tileerror', () => this.emit('tileerror'));
    this.tiles.on('tileload', () => this.emit('tileload'));
    this.map.on('move zoom', () => this.emit('move'));
    this.map.on('zoomend', () => this.emit('zoom'));
    this.map.on('resize', () => this.emit('resize'));
    this.map.on('click', (/** @type {any} */ e) => this.emit('click', { lat: e.latlng.lat, lng: e.latlng.lng }));
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
    const p = this.map.latLngToContainerPoint([lat, lng]);
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
    this.map.setView([lat, lng], zoom === undefined ? this.map.getZoom() : zoom, { animate: false });
  }

  /** @param {number} lat @param {number} lng */
  panTo(lat, lng) {
    this.map.panTo([lat, lng], { animate: true, duration: 0.18 });
  }

  zoomIn() {
    this.map.zoomIn();
  }

  zoomOut() {
    this.map.zoomOut();
  }

  /** Сколько пикселей в meters на широте lat. @param {number} lat @param {number} meters */
  metersToPixels(lat, meters) {
    const center = this.map.latLngToContainerPoint([lat, 0]);
    const edge = this.map.latLngToContainerPoint([lat, metersToLongitude(meters, lat)]);
    return Math.abs(edge.x - center.x);
  }

  /** Фильтр подложки по теме и ночному режиму. @param {string} filter */
  setFilter(filter) {
    const pane = this.map.getPane('tilePane');
    if (pane) pane.style.filter = filter;
  }

  invalidate() {
    this.map.invalidateSize();
  }

  /**
   * Рисует видимые тайлы на canvas (для «поделиться картинкой»).
   * @param {CanvasRenderingContext2D} ctx @param {DOMRect} origin @param {string} filter
   */
  drawBasemap(ctx, origin, filter) {
    ctx.save();
    ctx.filter = filter || 'none';
    this.container.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded').forEach((node) => {
      const img = /** @type {HTMLImageElement} */ (node);
      const r = img.getBoundingClientRect();
      try {
        ctx.drawImage(img, r.left - origin.left, r.top - origin.top, r.width, r.height);
      } catch (error) {
        /* тайл без CORS — пропускаем */
      }
    });
    ctx.restore();
  }

  destroy() {
    this.map.remove();
  }
}
