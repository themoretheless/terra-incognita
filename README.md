# Terra Incognita

Карта путешественника с туманом войны. Подложка — реальная карта OpenStreetMap,
поверх неё пелена, которая рассеивается там, где вы побывали, и остаётся
рассеянной навсегда: всё хранится в браузере (IndexedDB).

## Запуск

Интерфейс написан на [Svet](https://github.com/themoretheless/forma/tree/main/packages/svet)
и языке разметки Forma. Движок подключён git-подмодулем `vendor/forma`, поэтому клонировать
нужно вместе с ним:

```sh
git clone --recurse-submodules https://github.com/themoretheless/terra-incognita
cd terra-incognita
npm install          # ставит зависимости и собирает пакет svet-engine из подмодуля
npm start            # Vite → http://localhost:8080
```

Уже склонировали без подмодуля — `git submodule update --init`, затем `npm install`.

Разработка:

```sh
npm test             # юнит-тесты (node:test + fake-indexeddb)
npm run lint         # ESLint (JS и TS/TSX)
npm run typecheck    # tsc: JSDoc-типы в .js и TypeScript в src/ui
npm run build        # сборка в dist/ (заодно проверяет все .ui)
npm run bench        # бенчмарк хранилища: 10⁵ клеток / 10³ чанков
npm run preview      # собранная версия на http://localhost:8765
npm run test:e2e     # Playwright-сценарии поверх preview (см. CONTRIBUTING.md)
npm run svet:update  # подтянуть свежий Svet из подмодуля и пересобрать
```

## Возможности

- **Перемещение:** GPS (`watchPosition`) с фильтрами точности, скачков и стояния;
  интерполяция между фиксами, радиус по скорости (пешком / велосипед / авто), Wake Lock.
  Ручной режим — `WASD`, стрелки, клик по карте.
- **Треки:** запись по дням, отрисовка линией, импорт GPX / KML / GeoJSON, экспорт GPX.
- **Пелена:** стили Terra, Heroes III и Red Dead; режимы Heroes IV (обзор), Red Alert
  (отрастание), MOBA (варды-флажки), гексы (Age of Wonders). Мягкий край, кайма,
  crossfade при смене стиля, растеризация в Web Worker, перерисовка только по изменению.
- **Подложка:** растровые тайлы OSM или векторные (MapLibre + OpenFreeMap) с палитрами
  тем, ночной режим по закату, мини-карта, шкала, офлайн-кэш тайлов (Service Worker).
- **Игра:** прогресс по административному району (Overpass), места из OSM, квесты
  со стрелкой, ближайшее неразведанное, опыт и уровни, 14 достижений, серии дней,
  журнал, хроника открытий, испытание недели, улицы, хороплет районов, тепловая карта,
  флажки и фото-заметки, сравнение с другом, картинка «моя карта».
- **Данные:** IndexedDB v3 с RLE-сжатием, флагом полного чанка, пирамидой агрегатов,
  LRU, синхронизацией вкладок, persistent storage. Экспорт gzip с контрольной суммой,
  импорт с режимами объединить / заменить / вычесть и отменой, H3, GeoJSON,
  автобэкап в файл, заготовка облачной синхронизации.
- **Интерфейс:** Svet (сигналы, JSX) и Forma (`.ui`), настройки, оформление Heroes и Red Dead, мобильный нижний лист,
  онбординг, горячие клавиши (`?`), RU/EN, PWA, светлая системная тема, доступность.

Подробнее: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATA-FORMAT.md](docs/DATA-FORMAT.md),
[CONTRIBUTING.md](CONTRIBUTING.md). Дизайн-макеты — в `design/`.

Данные карты © участники OpenStreetMap, ODbL.
