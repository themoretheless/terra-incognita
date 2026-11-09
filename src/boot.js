// @ts-check
/**
 * Загрузчик: сначала WASM-ядро Svet отдельным файлом (потоковая компиляция и кэш браузера),
 * затем само приложение. Модули приложения создают сигналы при импорте, поэтому
 * подключаются только после того, как ядро готово.
 */
import { loadSvetWasm } from 'svet-engine/slim';
import wasmUrl from 'svet-engine/core.wasm?url';

try {
  await loadSvetWasm(fetch(wasmUrl));
  await import('./main.js');
} catch (error) {
  console.error(error);
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.style.cssText = 'margin:24px;font:16px system-ui,sans-serif';
  message.textContent = `Не удалось запустить карту: ${/** @type {Error} */ (error).message}`;
  document.body.appendChild(message);
}
