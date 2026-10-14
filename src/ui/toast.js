// @ts-check
/** Всплывающие уведомления вместо строки статуса. Объявляются через aria-live. */

/** @type {HTMLElement | null} */
let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * @param {string} message
 * @param {{ kind?: 'info' | 'ok' | 'warn' | 'error' | 'achievement', duration?: number, action?: { label: string, run: () => void } }} [options]
 */
export function toast(message, options = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${options.kind || 'info'}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  if (options.action) {
    const action = options.action;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.run();
      el.remove();
    });
    el.appendChild(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  ensureHost().appendChild(el);
  const duration = options.duration ?? (options.action ? 9000 : 4000);
  if (duration > 0) setTimeout(() => el.remove(), duration);
  return el;
}
