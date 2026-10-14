// @ts-check
/**
 * Пользовательские метки (флажки) и фото-заметки, плюс слой DOM-маркеров
 * поверх карты. Маркеры на неразведанных клетках не показываются — подписи
 * не «просвечивают» сквозь пелену.
 */
import { STORES, promisify, done } from './db.js';

/**
 * @typedef {{ id: string, lat: number, lng: number, title: string, kind: 'flag' | 'photo', photo?: Blob, t: number }} Note
 */

export class NotesStore {
  /** @param {IDBDatabase | null} db */
  constructor(db) {
    this.db = db;
    /** @type {Map<string, Note>} */
    this.notes = new Map();
    this.ready = this.load();
  }

  async load() {
    if (!this.db) return this;
    const tx = this.db.transaction(STORES.notes, 'readonly');
    /** @type {Note[]} */
    const rows = await promisify(tx.objectStore(STORES.notes).getAll());
    rows.forEach((n) => this.notes.set(n.id, n));
    return this;
  }

  /** @param {Omit<Note, 'id' | 't'>} data */
  async add(data) {
    /** @type {Note} */
    const note = { ...data, id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, t: Date.now() };
    this.notes.set(note.id, note);
    if (this.db) {
      const tx = this.db.transaction(STORES.notes, 'readwrite');
      tx.objectStore(STORES.notes).put(note);
      await done(tx);
    }
    return note;
  }

  /** @param {string} id */
  async remove(id) {
    this.notes.delete(id);
    if (this.db) {
      const tx = this.db.transaction(STORES.notes, 'readwrite');
      tx.objectStore(STORES.notes).delete(id);
      await done(tx);
    }
  }

  list() {
    return [...this.notes.values()].sort((a, b) => b.t - a.t);
  }
}

/**
 * @typedef {{ id: string, lat: number, lng: number, html: string, className: string, label: string,
 *   requireRevealed?: boolean, onClick?: () => void }} MarkerSpec
 */

export class MarkerLayer {
  /**
   * @param {HTMLElement} container @param {any} view
   * @param {(lat: number, lng: number) => boolean | null} isRevealed
   */
  constructor(container, view, isRevealed) {
    this.container = container;
    this.view = view;
    this.isRevealed = isRevealed;
    /** @type {Map<string, {spec: MarkerSpec, el: HTMLElement}>} */
    this.items = new Map();
  }

  /** @param {MarkerSpec[]} specs */
  set(specs) {
    const ids = new Set(specs.map((s) => s.id));
    this.items.forEach((item, id) => {
      if (!ids.has(id)) {
        item.el.remove();
        this.items.delete(id);
      }
    });
    specs.forEach((spec) => {
      let item = this.items.get(spec.id);
      if (!item) {
        const el = document.createElement('button');
        el.type = 'button';
        this.container.appendChild(el);
        item = { spec, el };
        this.items.set(spec.id, item);
      }
      item.spec = spec;
      item.el.className = `map-marker ${spec.className}`;
      item.el.innerHTML = spec.html;
      item.el.setAttribute('aria-label', spec.label);
      item.el.title = spec.label;
      item.el.onclick = (e) => {
        e.stopPropagation();
        if (spec.onClick) spec.onClick();
      };
    });
    this.update();
  }

  update() {
    const rect = this.container.getBoundingClientRect();
    this.items.forEach(({ spec, el }) => {
      const p = this.view.project(spec.lat, spec.lng);
      const inView = p.x > -40 && p.y > -40 && p.x < rect.width + 40 && p.y < rect.height + 40;
      const visible = inView && (!spec.requireRevealed || this.isRevealed(spec.lat, spec.lng) === true);
      el.hidden = !visible;
      if (visible) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    });
  }
}
