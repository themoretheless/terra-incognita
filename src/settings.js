// @ts-check
/**
 * Настройки приложения с сохранением в localStorage и подпиской на изменения.
 */

export const DEFAULTS = {
  theme: 'terra', // terra | heroes | western — стиль пелены
  ui: 'classic', // classic | heroes | reddead — оформление интерфейса
  fogMode: 'classic', // classic | heroes4 | redalert | moba | hex
  radius: 30, // м — ручной режим
  radiusWalk: 30, // м — GPS пешком
  radiusBike: 20,
  radiusCar: 10,
  regrowDays: 30, // Red Alert: за сколько дней пелена отрастает полностью
  hexMeters: 30, // размер гекса
  visionMeters: 120, // Heroes IV: радиус текущего обзора
  input: 'manual', // manual | gps
  follow: true, // камера следует за путешественником
  showTrack: false,
  showHeat: false,
  basemap: 'raster', // raster | vector
  night: 'auto', // auto | on | off
  lang: 'ru', // ru | en
  start: { lat: 48.8566, lng: 2.3522 },
  debug: false,
  autoBackupMinutes: 0, // 0 — выключено
  syncUrl: '', // облачная синхронизация: URL PUT/GET
  onboarded: false
};

/** @typedef {typeof DEFAULTS} SettingsData */
/** @typedef {keyof SettingsData} SettingsKey */

const KEY = 'terra-settings';
const LEGACY_THEME = 'terra-theme';

export class Settings {
  /** @param {Storage | null} [storage] */
  constructor(storage = globalThis.localStorage || null) {
    this.storage = storage;
    /** @type {SettingsData} */
    this.data = { ...DEFAULTS, start: { ...DEFAULTS.start } };
    /** @type {Array<(key: SettingsKey, value: any) => void>} */
    this.listeners = [];
    this.load();
  }

  load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
      const legacy = this.storage.getItem(LEGACY_THEME);
      if (!raw && legacy) this.data.theme = legacy;
    } catch (error) {
      /* битые настройки — остаются значения по умолчанию */
    }
  }

  save() {
    if (!this.storage) return;
    try {
      this.storage.setItem(KEY, JSON.stringify(this.data));
    } catch (error) {
      /* нет места — настройки живут до перезагрузки */
    }
  }

  /** @template {SettingsKey} K @param {K} key @returns {SettingsData[K]} */
  get(key) {
    return this.data[key];
  }

  /** @template {SettingsKey} K @param {K} key @param {SettingsData[K]} value */
  set(key, value) {
    if (JSON.stringify(this.data[key]) === JSON.stringify(value)) return;
    this.data[key] = value;
    this.save();
    this.listeners.forEach((fn) => fn(key, value));
  }

  /** @param {(key: SettingsKey, value: any) => void} fn */
  onChange(fn) {
    this.listeners.push(fn);
  }
}
