// E2E-сценарии: ходьба, перезагрузка, GPS, темы и режимы, панели, импорт/экспорт.
// Запуск: сервер на BASE_URL (по умолчанию http://localhost:8765) и `npm run test:e2e`.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:8765/index.html';
const executablePath = process.env.CHROMIUM_PATH || undefined;
const OUT = process.env.SHOTS || 'tests/e2e/screenshots';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['geolocation'], geolocation: { latitude: 48.8566, longitude: 2.3522 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/tile|Failed to load resource|overpass|net::/i.test(m.text()) && errors.push(m.text()));

await page.addInitScript(() => {
  if (!localStorage.getItem('terra-settings')) localStorage.setItem('terra-settings', JSON.stringify({ onboarded: true }));
});
await page.goto(BASE);
await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
check('загрузка без ошибок', errors.length === 0, errors.join(' | '));

const cells0 = await page.evaluate(() => window.terra.fog.totalCells);
await page.locator('#map-viewport').focus();
for (const k of ['d', 'd', 'd', 's', 's', 'a']) await page.keyboard.press(k);
await page.waitForTimeout(400);
const cells1 = await page.evaluate(() => window.terra.fog.totalCells);
check('ходьба открывает клетки', cells1 > cells0, `${cells0} → ${cells1}`);
await page.evaluate(() => window.terra.fog.flush());
await page.screenshot({ path: `${OUT}/walk.png` });

await page.reload();
await page.waitForSelector('html[data-ready="true"]');
await page.waitForTimeout(500);
const cells2 = await page.evaluate(() => window.terra.fog.totalCells);
check('сохранение после перезагрузки', cells2 >= cells1, `${cells1} → ${cells2}`);

for (const theme of ['heroes', 'western', 'terra']) {
  await page.click(`.theme-button[data-theme="${theme}"]`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/theme-${theme}.png` });
}
check('смена тем', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'terra');

for (const mode of ['heroes4', 'redalert', 'moba', 'hex', 'classic']) {
  await page.evaluate((m) => window.terra.settings.set('fogMode', m), mode);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/mode-${mode}.png` });
}
check('режимы пелены без ошибок', errors.length === 0, errors.join(' | '));

for (const ui of ['heroes', 'reddead', 'classic']) {
  await page.evaluate((u) => window.terra.settings.set('ui', u), ui);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/ui-${ui}.png` });
}

for (const panel of ['stats', 'journal', 'data', 'settings', 'help', 'share']) {
  await page.click(`[data-panel="${panel}"]`);
  await page.waitForSelector('dialog[open]');
  await page.screenshot({ path: `${OUT}/panel-${panel}.png` });
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog[open]', { state: 'detached' });
}
check('панели открываются', errors.length === 0, errors.join(' | '));

const exported = await page.evaluate(() => window.terra.fog.exportJSON());
const restored = await page.evaluate(async (text) => {
  const { FogStore } = await import('./src/fog-store.js');
  const s = new FogStore({ factory: null, storage: null, broadcast: false });
  await s.importJSON(text, 'union');
  return s.totalCells;
}, exported);
check('экспорт → импорт', restored === cells2, `${restored} / ${cells2}`);

await page.evaluate(() => window.terra.settings.set('input', 'gps'));
await page.waitForTimeout(1200);
await context.setGeolocation({ latitude: 48.8569, longitude: 2.3522, accuracy: 10 });
await page.waitForTimeout(1500);
const gpsPlayer = await page.evaluate(() => window.terra.player);
check('GPS двигает путешественника', Math.abs(gpsPlayer.lat - 48.8569) < 0.0001, JSON.stringify(gpsPlayer));
await context.setGeolocation({ latitude: 48.8584, longitude: 2.2945, accuracy: 10 });
await page.waitForTimeout(1200);
const jumped = await page.evaluate(() => window.terra.player);
check('фильтр отбрасывает скачок', Math.abs(jumped.lng - 2.2945) > 0.01, JSON.stringify(jumped));
await page.screenshot({ path: `${OUT}/gps.png` });

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mobile.addInitScript(() => localStorage.setItem('terra-settings', JSON.stringify({ onboarded: true })));
await mobile.goto(BASE);
await mobile.waitForSelector('html[data-ready="true"]');
await mobile.screenshot({ path: `${OUT}/mobile.png` });
await mobile.click('#sheet-handle');
await mobile.waitForTimeout(400);
await mobile.screenshot({ path: `${OUT}/mobile-sheet.png` });
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth);
check('мобильная раскладка без горизонтальной прокрутки', !overflow);

check('итог без ошибок консоли', errors.length === 0, errors.join(' | '));
await browser.close();
process.exit(failures ? 1 : 0);
