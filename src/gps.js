// @ts-check
/**
 * GPS: слежение за позицией с фильтрами точности и скачков,
 * оценкой скорости, радиусом проявления по скорости и удержанием экрана.
 */
import { distance } from './geo.js';

/**
 * @typedef {{ lat: number, lng: number, t: number, acc: number, speed: number }} Fix
 * @typedef {{ walk: number, bike: number, car: number }} RadiusBySpeed
 */

export const DEFAULT_FILTERS = {
  maxAccuracy: 50, // м — хуже точность не принимаем
  maxSpeedKmh: 200, // км/ч — быстрее считаем скачком
  minMoveMeters: 3 // мельче шаг — шум на месте
};

/**
 * Решает, принять ли фикс, и считает скорость. Чистая функция — для тестов.
 * @param {Fix | null} prev
 * @param {{ lat: number, lng: number, t: number, acc: number, speed?: number | null }} next
 * @param {typeof DEFAULT_FILTERS} [filters]
 * @returns {{ accept: boolean, reason?: string, fix?: Fix }}
 */
export function filterFix(prev, next, filters = DEFAULT_FILTERS) {
  if (!Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return { accept: false, reason: 'nan' };
  if (next.acc > filters.maxAccuracy) return { accept: false, reason: 'accuracy' };
  if (!prev) return { accept: true, fix: { ...next, speed: Math.max(0, next.speed || 0) } };
  const d = distance(prev.lat, prev.lng, next.lat, next.lng);
  const dt = Math.max(0.001, (next.t - prev.t) / 1000);
  const speed = d / dt;
  if (speed * 3.6 > filters.maxSpeedKmh) return { accept: false, reason: 'jump' };
  if (d < Math.max(filters.minMoveMeters, next.acc / 4)) return { accept: false, reason: 'still' };
  const reported = next.speed != null && Number.isFinite(next.speed) ? next.speed : null;
  return { accept: true, fix: { ...next, speed: reported != null ? reported : speed } };
}

/**
 * Радиус проявления по скорости, м/с → м.
 * @param {number} speed  м/с
 * @param {RadiusBySpeed} radii
 */
export function radiusForSpeed(speed, radii) {
  const kmh = speed * 3.6;
  if (kmh < 8) return radii.walk;
  if (kmh < 30) return radii.bike;
  return radii.car;
}

export class GpsTracker {
  /**
   * @param {{ onFix: (fix: Fix) => void, onError?: (message: string) => void, onStatus?: (status: string) => void, filters?: typeof DEFAULT_FILTERS }} options
   */
  constructor(options) {
    this.onFix = options.onFix;
    this.onError = options.onError || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.filters = options.filters || DEFAULT_FILTERS;
    /** @type {number | null} */
    this.watchId = null;
    /** @type {Fix | null} */
    this.last = null;
    /** @type {any} */
    this.wakeLock = null;
    this.rejected = { accuracy: 0, jump: 0, still: 0, nan: 0 };
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && this.active) this.lockScreen();
    };
  }

  get active() {
    return this.watchId !== null;
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  start() {
    if (this.active) return;
    if (!GpsTracker.supported()) {
      this.onError('Геолокация недоступна в этом браузере');
      return;
    }
    this.onStatus('searching');
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handle(pos),
      (err) => {
        const messages = { 1: 'Доступ к геолокации запрещён', 2: 'Позиция недоступна', 3: 'Истекло время ожидания GPS' };
        this.onError(messages[/** @type {1|2|3} */ (err.code)] || err.message);
        if (err.code === 1) this.stop();
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
    this.lockScreen();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.last = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    this.onStatus('off');
  }

  /** @param {GeolocationPosition} pos */
  handle(pos) {
    const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: pos.timestamp || Date.now(), acc: pos.coords.accuracy, speed: pos.coords.speed };
    const result = filterFix(this.last, next, this.filters);
    if (!result.accept || !result.fix) {
      if (result.reason) this.rejected[/** @type {'accuracy'} */ (result.reason)] += 1;
      if (result.reason === 'accuracy') this.onStatus('weak');
      return;
    }
    this.last = result.fix;
    this.onStatus('tracking');
    this.onFix(result.fix);
  }

  /** Wake Lock: не гасить экран во время записи. */
  async lockScreen() {
    const nav = /** @type {any} */ (navigator);
    if (!nav.wakeLock || this.wakeLock) return;
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => {
        this.wakeLock = null;
      });
    } catch (error) {
      /* браузер отказал (например, вкладка не активна) — не критично */
    }
  }
}
