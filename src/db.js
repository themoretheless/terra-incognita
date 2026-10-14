// @ts-check
/**
 * IndexedDB: открытие базы и миграции схемы.
 *
 * Версии:
 *   1 — chunks {key, bits}
 *   2 — + chunk-index {key, count}
 *   3 — chunks {key, rle | full}, chunk-index {key, count, visited, full}, + tracks, notes, meta
 *
 * Каждая миграция — отдельная функция, тесты гоняют их по цепочке.
 */
import { encodeRLE, popcount } from './codec.js';

export const DB_NAME = 'terra-incognita';
export const DB_VERSION = 3;
export const STORES = {
  chunks: 'chunks',
  index: 'chunk-index',
  tracks: 'tracks',
  notes: 'notes',
  meta: 'meta'
};
export const CHUNK_BYTES = 8192;
export const CHUNK_CELLS = CHUNK_BYTES * 8;

/** Понятная ошибка хранилища для показа пользователю. */
export class StorageError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Переводит ошибку IndexedDB в StorageError с понятным текстом.
 * @param {any} error
 */
export function describeStorageError(error) {
  const name = (error && (error.name || error.code)) || '';
  if (name === 'QuotaExceededError' || /quota/i.test(String(error && error.message))) {
    return new StorageError('quota', 'Закончилось место для хранения карты. Освободите место в браузере или сделайте экспорт.');
  }
  if (name === 'InvalidStateError' || name === 'SecurityError') {
    return new StorageError('unavailable', 'Браузер не даёт сохранять данные (приватный режим или запрет хранилища). Открытое будет потеряно после закрытия вкладки.');
  }
  if (name === 'VersionError') {
    return new StorageError('version', 'Сохранение сделано более новой версией приложения. Обновите страницу.');
  }
  return new StorageError('unknown', `Ошибка хранилища: ${(error && error.message) || name || 'неизвестная'}`);
}

/**
 * Миграции. Получают базу и транзакцию обновления.
 * @type {Record<number, (db: IDBDatabase, tx: IDBTransaction) => void>}
 */
export const MIGRATIONS = {
  1(db) {
    if (!db.objectStoreNames.contains(STORES.chunks)) db.createObjectStore(STORES.chunks, { keyPath: 'key' });
  },
  2(db, tx) {
    if (db.objectStoreNames.contains(STORES.index)) return;
    const index = db.createObjectStore(STORES.index, { keyPath: 'key' });
    const cursor = tx.objectStore(STORES.chunks).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      index.put({ key: c.value.key, count: popcount(c.value.bits) });
      c.continue();
    };
  },
  3(db, tx) {
    ['tracks', 'notes', 'meta'].forEach((name) => {
      const storeName = STORES[/** @type {'tracks'|'notes'|'meta'} */ (name)];
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: name === 'tracks' ? 'day' : name === 'notes' ? 'id' : 'key' });
      }
    });
    // чанки: сырые 8 КБ → RLE; полные — одним флагом
    const chunks = tx.objectStore(STORES.chunks);
    const index = tx.objectStore(STORES.index);
    const cursor = chunks.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const value = c.value;
      if (value.bits) {
        const bits = value.bits instanceof Uint8Array ? value.bits : new Uint8Array(value.bits);
        const count = popcount(bits);
        const full = count === CHUNK_CELLS;
        c.update(full ? { key: value.key, full: true } : { key: value.key, rle: encodeRLE(bits) });
        index.put({ key: value.key, count, visited: 0, full });
      }
      c.continue();
    };
  }
};

/**
 * Открывает базу с прогоном недостающих миграций.
 * @param {IDBFactory} [factory]
 * @param {number} [version]
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(factory = globalThis.indexedDB, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new StorageError('unavailable', 'IndexedDB недоступна в этом браузере.'));
      return;
    }
    let request;
    try {
      request = factory.open(DB_NAME, version);
    } catch (error) {
      reject(describeStorageError(error));
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = /** @type {IDBTransaction} */ (request.transaction);
      for (let v = event.oldVersion + 1; v <= version; v += 1) {
        const migrate = MIGRATIONS[v];
        if (migrate) migrate(db, tx);
      }
    };
    request.onerror = () => reject(describeStorageError(request.error));
    request.onblocked = () => reject(new StorageError('blocked', 'Закройте другие вкладки с картой — они мешают обновить хранилище.'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

/**
 * Промис для одного запроса.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
export function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(describeStorageError(request.error));
  });
}

/**
 * Промис завершения транзакции.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
export function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(describeStorageError(tx.error));
    tx.onabort = () => reject(describeStorageError(tx.error));
  });
}
