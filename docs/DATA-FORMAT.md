# Формат данных

## Сетка

Клетка — тайл Web Mercator зума 22 (≈ 6 м на широте Парижа).
Чанк — 256×256 клеток = тайл зума 14, ключ `"x:y"`. Битовая карта — 8192 байта,
бит `(ly·256 + lx)`, младший бит первым.

## IndexedDB `terra-incognita`, версия 3

| Хранилище    | Ключ    | Значение |
|--------------|---------|----------|
| `chunks`     | `x:y`   | `{ rle: Uint8Array \| null, full?: true, heat?: Uint8Array }` |
| `chunk-index`| `key`   | `{ key, count, visited, full }` — лёгкий индекс для старта |
| `tracks`     | `day`   | `{ day: 'YYYY-MM-DD', points: [{lat, lng, t, acc?}] }`, `acc = -1` — разрыв |
| `notes`      | `id`    | `{ id, lat, lng, title, kind: 'flag' \| 'photo', photo?: Blob, t }` |
| `meta`       | `key`   | служебные значения |

RLE: последовательность записей `тег, длина(uint16 LE)[, байты]`, где тег 0 —
нули, 1 — `0xFF`, 2 — литералы. Полностью открытый чанк хранится флагом `full`.
Тепловая карта — 64×64 счётчика (блок 4×4 клетки), тоже RLE.

Миграции: v1 (сырые битовые карты) → v2 (индекс) → v3 (RLE, full, heat, tracks, notes).
Каждая покрыта тестом в `tests/unit/fog-store.test.js`.

## Экспорт пелены, версия 2

```json
{
  "format": "terra-incognita-fog", "version": 2,
  "cellZoom": 22, "chunkBits": 8,
  "exportedAt": "…", "cells": 12345,
  "checksum": "fnv1a-hex по ключам и данным",
  "chunks": { "x:y": { "rle": "base64", "visited": 0 } }
}
```

Файл обычно сжат gzip (`.json.gz`). Версия 1 (`chunks: {key: base64}`) читается.
При несовпадении контрольной суммы импорт отклоняется.

## H3

`{ "format": "terra-incognita-h3", "version": 1, "resolution": 11, "cells": [...] }` —
ячейки после `compactCells`.

## GeoJSON

`FeatureCollection` из `MultiPolygon` по чанкам; внешние кольца против часовой стрелки.
