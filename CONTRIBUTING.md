# Как помочь проекту

1. Клонируйте с подмодулем (`git clone --recurse-submodules …`), затем `npm install`
   и `npm start` — приложение откроется на http://localhost:8080.
2. Перед коммитом: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`.
3. E2E: `npm run build && npm run preview` (порт 8765), в другом терминале `npm run test:e2e`.
   Свой Chromium можно указать в `CHROMIUM_PATH`, скриншоты сохраняются в `tests/e2e/screenshots`.

Правила:

- Интерфейс — Svet и Forma: состояние в `src/ui/model.ts`, декларативные области в `src/ui/views/*.ui`,
  формы и оболочка в `.tsx`. Остальные модули — в `src/`, с `// @ts-check` и JSDoc-типами.
- Svet импортируем только как `svet-engine/slim`: импорт `svet-engine` вернёт в бандл
  встроенное WASM-ядро и GPU-модуль (около 100 КБ).
- Движок не правим на месте: изменения Svet вносятся в репозитории forma, сюда приходят через
  `npm run svet:update`.
- `FogStore` — источник правды; не дублируйте открытое в других местах.
- Меняете формат IndexedDB — увеличьте `DB_VERSION`, добавьте миграцию в `db.js` и тест.
- Меняете формат экспорта — увеличьте `version` и сохраните чтение старых версий.
- Внешние скрипты — только с закреплённой версией и SRI.
- Уважайте [политику тайлов OSM](https://operations.osmfoundation.org/policies/tiles/) и атрибуцию.
