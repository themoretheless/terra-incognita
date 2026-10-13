# Дизайн: проявление карты и интерфейс

Канвас с макетами: https://claude.ai/artifact/1VprPaAE5uUxLyJ1ozdD1b
(приватный, открывается после шаринга из меню Share).

## Содержимое

- `canvas/project/` — исходники артбордов канваса (`.dc.html`) и индекс `canvas.json`.
  - `Main` / `Heroes` — карта с пеленой в стилях Red Dead и Heroes III/IV.
  - `EdgeRedDead` / `EdgeHeroes` / `Timeline` / `Spec` — анатомия края, тайминги, параметры.
  - `UIRedDead` / `UIHeroes` / `UIKit` — страница Red Dead, главное окно Heroes, UI-кит.
  - `RTS` / `RedAlert` / `Moba` / `Hex` / `Spec2` — другие модели тумана войны.
- `assets/` — подложки 960×608 вокруг стартовой точки приложения (48.8566, 2.3522), зум 16:
  - `osm-paris-z16.png` — склейка растровых тайлов OSM;
  - `osm-heroes.png` — те же данные OSM, отрисованные в стиле Heroes;
  - `osm-parchment.png` — в стиле пергамента Red Dead.
- `tools/` — скрипты, которыми сделаны подложки:
  - `bbox.py` — bbox кадра; `stitch2.py` — склейка тайлов;
  - `overpass-query.ql` — запрос данных OSM; `render.py` — отрисовка двух стилей из JSON Overpass;
  - `inspect.py` — сводка по скачанным данным.

В артбордах ссылки на подложки вида `/_blob/<id>` указывают на хранилище канваса;
для локального просмотра замените их на файлы из `assets/`.

Данные и тайлы © OpenStreetMap contributors (ODbL).
