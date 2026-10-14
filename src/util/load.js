// @ts-check
/** Загрузка внешних скриптов и стилей по требованию, с проверкой SRI. */

/** @type {Map<string, Promise<void>>} */
const cache = new Map();

/** @param {string} src @param {string} [integrity] */
export function loadScript(src, integrity) {
  if (cache.has(src)) return /** @type {Promise<void>} */ (cache.get(src));
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    if (integrity) script.integrity = integrity;
    script.onload = () => resolve(undefined);
    script.onerror = () => {
      cache.delete(src);
      reject(new Error(`не удалось загрузить ${src}`));
    };
    document.head.appendChild(script);
  });
  cache.set(src, /** @type {Promise<void>} */ (promise));
  return /** @type {Promise<void>} */ (promise);
}

/** @param {string} href @param {string} [integrity] */
export function loadStyle(href, integrity) {
  if (cache.has(href)) return /** @type {Promise<void>} */ (cache.get(href));
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    if (integrity) link.integrity = integrity;
    link.onload = () => resolve(undefined);
    link.onerror = () => reject(new Error(`не удалось загрузить ${href}`));
    document.head.appendChild(link);
  });
  cache.set(href, /** @type {Promise<void>} */ (promise));
  return /** @type {Promise<void>} */ (promise);
}

export const H3 = {
  src: 'https://unpkg.com/h3-js@4.1.0/dist/h3-js.umd.js',
  integrity: 'sha384-nKUDlg+fT0U/eEt4KWP9n034kLe/eVj6k7CVjbu6qfRhJdEyinlGajS9+9AU+UZ5'
};

/** @returns {Promise<any>} */
export async function loadH3() {
  const g = /** @type {any} */ (globalThis);
  if (g.h3) return g.h3;
  await loadScript(H3.src, H3.integrity);
  if (!g.h3) throw new Error('h3-js не загрузился');
  return g.h3;
}

/**
 * Скачивание файла.
 * @param {string} filename @param {Blob | string} data @param {string} [type]
 */
export function download(filename, data, type = 'application/json') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Короткий helper для элементов. @param {string} selector @param {ParentNode} [root] */
export function $(selector, root = document) {
  return /** @type {HTMLElement} */ (root.querySelector(selector));
}

/**
 * Создание элемента с атрибутами и детьми.
 * @param {string} tag @param {Record<string, any>} [attrs] @param {Array<Node | string>} [children]
 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (v === false || v === null || v === undefined) return;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  });
  children.forEach((c) => el.append(c));
  return el;
}
