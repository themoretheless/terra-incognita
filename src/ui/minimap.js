// @ts-check
/**
 * Мини-карта как в главном окне Heroes: мелкий масштаб, рамка текущего вида
 * и разведанные чанки из индекса хранилища. Клик — перейти.
 */
import { parseChunkKey, CHUNK_ZOOM } from '../fog-store.js';
import { unproject } from '../geo.js';
import { OSM_ATTRIBUTION } from '../map/leaflet-view.js';

export class Minimap {
  /**
   * @param {HTMLElement} container @param {any} view @param {import('../fog-store.js').FogStore} fog
   */
  constructor(container, view, fog) {
    const Leaflet = /** @type {any} */ (globalThis).L;
    this.view = view;
    this.fog = fog;
    this.map = Leaflet.map(container, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false
    });
    Leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: OSM_ATTRIBUTION }).addTo(this.map);
    this.explored = Leaflet.layerGroup().addTo(this.map);
    this.frame = Leaflet.rectangle(
      [
        [0, 0],
        [0, 0]
      ],
      { color: '#ffe9a8', weight: 1.5, fill: false, interactive: false }
    ).addTo(this.map);
    this.map.on('click', (/** @type {any} */ e) => this.view.panTo(e.latlng.lat, e.latlng.lng));
    this.lastIndexSize = -1;
    this.update();
  }

  update() {
    const Leaflet = /** @type {any} */ (globalThis).L;
    const c = this.view.getCenter();
    const z = Math.max(1, this.view.getZoom() - 4);
    this.map.setView([c.lat, c.lng], z, { animate: false });
    const b = this.view.getBounds();
    this.frame.setBounds([
      [b.south, b.west],
      [b.north, b.east]
    ]);
    if (this.fog.index.size !== this.lastIndexSize) {
      this.lastIndexSize = this.fog.index.size;
      this.explored.clearLayers();
      this.fog.index.forEach((entry, key) => {
        if (!entry.count) return;
        const { cx, cy } = parseChunkKey(key);
        const nw = unproject(cx, cy, CHUNK_ZOOM);
        const se = unproject(cx + 1, cy + 1, CHUNK_ZOOM);
        const share = Math.min(1, entry.count / 65536);
        Leaflet.rectangle(
          [
            [se.lat, nw.lng],
            [nw.lat, se.lng]
          ],
          { stroke: false, fillColor: '#f5a866', fillOpacity: 0.25 + share * 0.6, interactive: false }
        ).addTo(this.explored);
      });
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
