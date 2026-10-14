# Как помочь проекту

1. `npm install`, затем `npm start` и откройте http://localhost:8080.
2. Перед коммитом: `npm run lint && npm run format:check && npm run typecheck && npm test`.
3. E2E: запустите сервер на 8765 (`python3 -m http.server 8765`) и
   `npm run test:e2e`. Свой Chromium можно указать в `CHROMIUM_PATH`,
   скриншоты сохраняются в `tests/e2e/screenshots`.

Правила:

- Без сборщика и фреймворков; новые модули — в `src/`, с `// @ts-check` и JSDoc-типами.
- `FogStore` — источник правды; не дублируйте открытое в других местах.
- Меняете формат IndexedDB — увеличьте `DB_VERSION`, добавьте миграцию в `db.js` и тест.
- Меняете формат экспорта — увеличьте `version` и сохраните чтение старых версий.
- Внешние скрипты — только с закреплённой версией и SRI.
- Уважайте [политику тайлов OSM](https://operations.osmfoundation.org/policies/tiles/) и атрибуцию.
