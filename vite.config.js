import { defineConfig } from 'vite';
// Движок Svet и компилятор Forma — пакет из подмодуля vendor/forma (packages/svet).
import { compileFormaToJsModule, validateFormaSource } from 'svet-engine';

// Облегчённая точка входа: без встроенной base64-копии WASM-ядра и без 3D-контролов Forma.
const SVET = 'svet-engine/slim';

/**
 * Forma `.ui` → ES-модуль с заранее разобранным AST; ошибки разметки роняют сборку.
 * Штатный svetVitePlugin делает то же и вдобавок сам оборачивает выражения JSX в стрелки.
 * Здесь реактивные выражения в .tsx записаны стрелками явно, поэтому автообёртка не нужна:
 * с ней свойства-массивы и готовые функции превратились бы в функции от функций.
 * @returns {import('vite').Plugin}
 */
function formaUi() {
  let production = false;
  return {
    name: 'forma-ui',
    enforce: 'pre',
    configResolved(config) {
      production = config.command === 'build';
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.ui')) return null;
      const errors = validateFormaSource(code).diagnostics.filter((d) => d.severity === 'error');
      if (errors.length) this.error(`${file}: ${errors.map((d) => `${d.line ? `строка ${d.line}: ` : ''}${d.message}`).join('; ')}`);
      return { code: compileFormaToJsModule(code, SVET, { embedSource: !production }), map: null };
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [formaUi()],
  oxc: { jsx: { runtime: 'automatic', importSource: SVET } },
  build: { target: 'es2022', sourcemap: true },
  server: { port: 8080 },
  preview: { port: 8765, strictPort: true }
});
