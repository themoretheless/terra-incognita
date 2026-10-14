// @ts-check
/**
 * Модальные панели: настройки, данные, статистика, журнал, хроника, шаринг,
 * справка, метки и онбординг. Все панели работают через общий объект app из main.js.
 */
import { openDialog, confirmTyped } from './dialog.js';
import { toast } from './toast.js';
import { h, download, formatBytes, loadH3 } from '../util/load.js';
import { getLang, formatArea, formatDistance } from '../i18n.js';
import { ACHIEVEMENTS, levelFor, streetCoverage, compareStores, createReplayStore } from '../game.js';
import { FogStore } from '../fog-store.js';
import { parseTrackFile, toGPX } from '../tracks.js';
import { fetchAreasIn, fetchStreets } from '../osm.js';
import { areaCoverage } from '../game.js';

/** Двуязычная строка. @param {string} ru @param {string} en */
const L = (ru, en) => (getLang() === 'en' ? en : ru);

/** @param {string} label @param {Node} control */
function field(label, control) {
  return h('label', { class: 'field' }, [h('span', {}, [label]), control]);
}

/** @param {string} key @param {Array<[string, string]>} options @param {any} app */
function select(app, key, options) {
  const el = /** @type {HTMLSelectElement} */ (
    h(
      'select',
      {},
      options.map(([value, text]) => h('option', { value }, [text]))
    )
  );
  el.value = String(app.settings.get(key));
  el.addEventListener('change', () => app.settings.set(key, el.value));
  return el;
}

/** @param {any} app @param {string} key @param {number} min @param {number} max @param {number} step */
function range(app, key, min, max, step) {
  const out = h('output', {}, [String(app.settings.get(key))]);
  const el = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min: String(min), max: String(max), step: String(step) }));
  el.value = String(app.settings.get(key));
  el.addEventListener('input', () => {
    out.textContent = el.value;
    app.settings.set(key, Number(el.value));
  });
  return h('span', { class: 'range' }, [el, out]);
}

/** @param {any} app @param {string} key */
function checkbox(app, key) {
  const el = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));
  el.checked = Boolean(app.settings.get(key));
  el.addEventListener('change', () => app.settings.set(key, el.checked));
  return el;
}

/** @param {string} text @param {() => any} onClick @param {string} [cls] */
function button(text, onClick, cls = '') {
  const el = h('button', { type: 'button', class: `chip-button ${cls}` }, [text]);
  el.addEventListener('click', async () => {
    el.setAttribute('aria-busy', 'true');
    try {
      await onClick();
    } catch (error) {
      toast(String(/** @type {Error} */ (error).message || error), { kind: 'error' });
    } finally {
      el.removeAttribute('aria-busy');
    }
  });
  return el;
}

/** @param {string} accept @returns {Promise<File | null>} */
function pickFile(accept) {
  return new Promise((resolve) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept }));
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.click();
  });
}

const stamp = () => new Date().toISOString().slice(0, 10);

// ---------- панели ----------

/** @type {Record<string, (app: any, arg?: any) => void>} */
const PANELS = {
  settings(app) {
    const usage = h('p', { class: 'muted' }, ['…']);
    app.fog.estimate().then((/** @type {any} */ e) => {
      usage.textContent = e
        ? `${L('Занято', 'Used')}: ${formatBytes(e.usage || 0)} / ${formatBytes(e.quota || 0)} · ${e.persisted ? L('постоянное хранилище', 'persistent storage') : L('хранилище может быть очищено браузером', 'storage may be evicted')}`
        : '—';
    });
    const body = h('div', { class: 'form-grid' }, [
      h('h3', {}, [L('Пелена', 'Fog')]),
      field(
        L('Стиль', 'Theme'),
        select(app, 'theme', [
          ['terra', 'Terra Incognita'],
          ['heroes', 'Heroes III'],
          ['western', 'Red Dead']
        ])
      ),
      field(
        L('Интерфейс', 'Interface'),
        select(app, 'ui', [
          ['classic', L('Классический', 'Classic')],
          ['heroes', 'Heroes'],
          ['reddead', 'Red Dead']
        ])
      ),
      field(
        L('Режим пелены', 'Fog mode'),
        select(app, 'fogMode', [
          ['classic', L('Классика', 'Classic')],
          ['heroes4', 'Heroes IV'],
          ['redalert', 'Red Alert'],
          ['moba', 'MOBA'],
          ['hex', L('Гексы', 'Hexes')]
        ])
      ),
      field(L('Радиус (вручную), м', 'Radius (manual), m'), range(app, 'radius', 10, 120, 5)),
      field(L('Обзор Heroes IV, м', 'Heroes IV vision, m'), range(app, 'visionMeters', 40, 400, 10)),
      field(L('Отрастание Red Alert, дней', 'Red Alert regrow, days'), range(app, 'regrowDays', 1, 365, 1)),
      field(L('Гекс, м', 'Hex size, m'), range(app, 'hexMeters', 10, 200, 5)),
      h('h3', {}, ['GPS']),
      field(
        L('Ввод', 'Input'),
        select(app, 'input', [
          ['manual', L('Вручную', 'Manual')],
          ['gps', 'GPS']
        ])
      ),
      field(L('Пешком, м', 'Walking, m'), range(app, 'radiusWalk', 10, 80, 5)),
      field(L('Велосипед, м', 'Bike, m'), range(app, 'radiusBike', 5, 60, 5)),
      field(L('Авто, м', 'Car, m'), range(app, 'radiusCar', 5, 40, 5)),
      field(L('Камера следует', 'Follow camera'), checkbox(app, 'follow')),
      h('h3', {}, [L('Карта', 'Map')]),
      field(
        L('Подложка', 'Basemap'),
        select(app, 'basemap', [
          ['raster', L('Растр OSM', 'OSM raster')],
          ['vector', L('Вектор (MapLibre)', 'Vector (MapLibre)')]
        ])
      ),
      field(
        L('Ночь', 'Night'),
        select(app, 'night', [
          ['auto', L('По закату', 'By sunset')],
          ['on', L('Всегда', 'Always')],
          ['off', L('Выкл.', 'Off')]
        ])
      ),
      field(L('Трек', 'Track'), checkbox(app, 'showTrack')),
      field(L('Тепловая карта', 'Heat map'), checkbox(app, 'showHeat')),
      field(
        L('Язык', 'Language'),
        select(app, 'lang', [
          ['ru', 'Русский'],
          ['en', 'English']
        ])
      ),
      field(
        L('Стартовая точка', 'Start point'),
        button(L('Текущий центр карты', 'Current map centre'), () => {
          const c = app.view.getCenter();
          app.settings.set('start', { lat: c.lat, lng: c.lng });
          toast(L('Стартовая точка сохранена', 'Start point saved'));
        })
      ),
      field(L('Отладка', 'Debug'), checkbox(app, 'debug')),
      h('h3', {}, [L('Резервные копии', 'Backups')]),
      field(L('Автобэкап, мин (0 — выкл.)', 'Auto-backup, min (0 = off)'), range(app, 'autoBackupMinutes', 0, 240, 15)),
      field(
        L('Файл бэкапа', 'Backup file'),
        button(L('Выбрать…', 'Choose…'), () => chooseBackupFile(app))
      ),
      field(L('URL синхронизации', 'Sync URL'), syncInput(app)),
      h('div', { class: 'row' }, [button(L('Отправить', 'Push'), () => syncPush(app)), button(L('Получить', 'Pull'), () => syncPull(app))]),
      h('h3', {}, [L('Хранилище', 'Storage')]),
      usage,
      button(L('Запросить постоянное хранение', 'Request persistent storage'), async () => {
        const ok = await app.fog.requestPersistence();
        toast(ok ? L('Браузер не будет удалять данные', 'Data will not be evicted') : L('Браузер отказал', 'Browser declined'));
      })
    ]);
    openDialog({ title: L('Настройки', 'Settings'), body, wide: true });
  },

  data(app) {
    const mode = /** @type {HTMLSelectElement} */ (
      h('select', {}, [
        h('option', { value: 'union' }, [L('Объединить', 'Union')]),
        h('option', { value: 'replace' }, [L('Заменить', 'Replace')]),
        h('option', { value: 'subtract' }, [L('Вычесть', 'Subtract')])
      ])
    );
    const body = h('div', { class: 'form-grid' }, [
      h('h3', {}, [L('Экспорт', 'Export')]),
      h('div', { class: 'row' }, [
        button(L('Пелена (.json.gz)', 'Fog (.json.gz)'), async () => {
          const { blob, gzip } = await app.fog.exportBlob();
          download(`terra-fog-${stamp()}.json${gzip ? '.gz' : ''}`, blob);
        }),
        button('H3', async () => {
          const h3 = await loadH3();
          download(`terra-h3-${stamp()}.json`, await app.fog.exportH3(h3, 11), 'application/json');
        }),
        button('GeoJSON', async () => download(`terra-${stamp()}.geojson`, await app.fog.exportGeoJSON(), 'application/geo+json')),
        button('GPX', async () => download(`terra-tracks-${stamp()}.gpx`, toGPX(app.tracks.allSegments()), 'application/gpx+xml'))
      ]),
      h('h3', {}, [L('Импорт', 'Import')]),
      field(L('Режим слияния пелены', 'Fog merge mode'), mode),
      h('div', { class: 'row' }, [
        button(L('Файл…', 'File…'), () => importAny(app, /** @type {any} */ (mode.value))),
        button(L('Отменить импорт', 'Undo import'), async () => {
          const ok = await app.fog.undoImport();
          toast(ok ? L('Импорт отменён', 'Import undone') : L('Нечего отменять', 'Nothing to undo'));
          app.refreshAll();
        })
      ]),
      h('p', { class: 'muted' }, [L('Поддерживаются: экспорт пелены (.json, .gz), H3, GPX, KML, GeoJSON.', 'Supported: fog export (.json, .gz), H3, GPX, KML, GeoJSON.')]),
      h('h3', {}, [L('Сравнение с другом', 'Compare with a friend')]),
      h('div', { class: 'row' }, [
        button(L('Открыть файл друга…', 'Open friend’s file…'), () => compareFriend(app)),
        button(L('Скрыть', 'Hide'), () => {
          app.renderer.compare = null;
          app.renderer.compareCache.clear();
          app.renderer.requestDraw();
        })
      ]),
      h('h3', { class: 'danger-text' }, [L('Опасная зона', 'Danger zone')]),
      button(
        L('Стереть всё', 'Erase everything'),
        async () => {
          const word = L('стереть', 'erase');
          const ok = await confirmTyped({
            title: L('Стереть карту?', 'Erase the map?'),
            text: L('Будут удалены пелена, треки и метки. Экспортируйте данные заранее.', 'Fog, tracks and notes will be deleted. Export first.'),
            word
          });
          if (!ok) return;
          await app.fog.clear();
          await app.tracks.clear();
          app.game.reset();
          app.refreshAll();
          toast(L('Карта очищена', 'Map erased'));
        },
        'danger'
      )
    ]);
    openDialog({ title: L('Данные', 'Data'), body, wide: true });
  },

  stats(app) {
    const g = app.game;
    const lv = levelFor(g.state.xp);
    const best = g.bestDay();
    const area = app.fog.revealedArea(app.player.lat);
    const coverage = h('p', { class: 'muted' }, [
      app.area && app.areaCoverage ? `${app.area.name}: ${(app.areaCoverage.ratio * 100).toFixed(2)}%` : L('Район не определён', 'District unknown')
    ]);
    const streets = h('p', { class: 'muted' }, ['—']);
    const body = h('div', { class: 'stats' }, [
      h('dl', { class: 'stat-grid' }, [
        stat(L('Площадь', 'Area'), formatArea(area)),
        stat(L('Клеток', 'Cells'), app.fog.totalCells.toLocaleString()),
        stat(L('Пройдено', 'Walked'), formatDistance(app.tracks.totalMeters())),
        stat(L('Уровень', 'Level'), `${lv.level} · ${g.state.xp} XP`),
        stat(L('Сегодня', 'Today'), `+${g.today()}`),
        stat(L('За неделю', 'This week'), `+${g.week()}`),
        stat(L('Серия дней', 'Streak'), String(g.streak())),
        stat(L('Лучший день', 'Best day'), best.cells ? `${best.day} · +${best.cells}` : '—'),
        stat(L('Находки', 'Finds'), String(Object.keys(g.state.pois).length))
      ]),
      h('h3', {}, [L('Достижения', 'Achievements')]),
      h(
        'ul',
        { class: 'achievements' },
        ACHIEVEMENTS.map((a) => {
          const at = g.state.achievements[a.id];
          return h('li', { class: at ? 'unlocked' : '', title: at ? new Date(at).toLocaleDateString() : L('Не открыто', 'Locked') }, [
            h('span', { class: 'icon', 'aria-hidden': 'true' }, [a.icon]),
            getLang() === 'en' ? a.nameEn : a.name
          ]);
        })
      ),
      h('h3', {}, [L('Район', 'District')]),
      coverage,
      h('div', { class: 'row' }, [
        button(L('Посчитать улицы', 'Count streets'), async () => {
          if (!app.area) throw new Error(L('Район не определён', 'District unknown'));
          streets.textContent = L('Загружаю улицы…', 'Loading streets…');
          const list = await fetchStreets(app.area, 25);
          const r = await streetCoverage(app.fog, list);
          streets.textContent = `${L('Пройдено улиц', 'Streets done')}: ${r.done} / ${r.total}`;
        }),
        button(L('Хороплет районов', 'District choropleth'), () => toggleChoropleth(app)),
        button(L('Испытание: 5% за неделю', 'Challenge: 5% in a week'), async () => {
          if (!app.area || !app.areaCoverage) throw new Error(L('Район не определён', 'District unknown'));
          g.startChallenge(app.area, app.areaCoverage.revealed, app.areaCoverage.total, 5);
          toast(L('Испытание началось', 'Challenge started'));
          app.refreshAll();
        })
      ]),
      streets
    ]);
    openDialog({ title: L('Статистика', 'Statistics'), body, wide: true });
  },

  journal(app) {
    const rows = app.game.journal(app.tracks.days);
    const body = rows.length
      ? h(
          'ol',
          { class: 'journal' },
          rows.map((/** @type {any} */ r) =>
            h('li', {}, [
              h('b', {}, [r.day]),
              h('span', {}, [` +${r.cells} ${L('клеток', 'cells')} · ${formatDistance(r.meters)}`]),
              r.pois.length ? h('small', {}, [r.pois.join(', ')]) : ''
            ])
          )
        )
      : h('p', { class: 'muted' }, [L('Записей пока нет — отправляйтесь в путь.', 'No entries yet — go explore.')]);
    openDialog({ title: L('Журнал экспедиции', 'Expedition journal'), body });
  },

  timeline(app) {
    const days = [...app.tracks.days.keys()].sort();
    if (!days.length) {
      openDialog({
        title: L('Хроника', 'Timeline'),
        body: h('p', { class: 'muted' }, [L('Нет треков для воспроизведения. Включите GPS или импортируйте GPX.', 'No tracks to replay. Enable GPS or import GPX.')])
      });
      return;
    }
    const replay = createReplayStore(FogStore);
    const label = h('output', {}, [days[0]]);
    const slider = /** @type {HTMLInputElement} */ (h('input', { type: 'range', min: '0', max: String(days.length - 1), value: '0' }));
    let shown = -1;
    const showUntil = async (/** @type {number} */ index) => {
      if (index < shown) {
        replay.chunks.clear();
        replay.totalCells = 0;
        shown = -1;
      }
      for (let i = shown + 1; i <= index; i += 1) {
        for (const seg of app.tracks.segments(days[i])) await replay.revealPath(seg, app.settings.get('radiusWalk'));
      }
      shown = index;
      label.textContent = days[index];
      app.renderer.source = replay;
      app.renderer.requestDraw();
    };
    slider.addEventListener('input', () => showUntil(Number(slider.value)));
    let timer = /** @type {any} */ (null);
    const play = button(L('▶ Воспроизвести', '▶ Play'), () => {
      clearInterval(timer);
      slider.value = '0';
      showUntil(0);
      timer = setInterval(() => {
        const next = Number(slider.value) + 1;
        if (next >= days.length) return clearInterval(timer);
        slider.value = String(next);
        showUntil(next);
      }, 700);
    });
    showUntil(0);
    openDialog({
      title: L('Хроника открытий', 'Discovery timeline'),
      body: h('div', { class: 'form-grid' }, [field(L('День', 'Day'), h('span', { class: 'range' }, [slider, label])), play]),
      onClose: () => {
        clearInterval(timer);
        app.renderer.source = app.fog;
        app.renderer.cache.clear();
        app.renderer.requestDraw();
      }
    });
  },

  share(app) {
    const title = `Terra Incognita · ${formatArea(app.fog.revealedArea(app.player.lat))} · ${stamp()}`;
    const canvas = app.renderer.compose(app.basemapFilter(), title);
    const img = h('img', { class: 'share-preview', alt: title, src: canvas.toDataURL('image/png') });
    const toBlob = () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    openDialog({
      title: L('Поделиться картой', 'Share the map'),
      body: h('div', {}, [
        img,
        h('div', { class: 'row' }, [
          button(L('Скачать PNG', 'Download PNG'), async () => download(`terra-${stamp()}.png`, /** @type {Blob} */ (await toBlob()))),
          navigator.share
            ? button(L('Поделиться…', 'Share…'), async () => {
                const file = new File([/** @type {Blob} */ (await toBlob())], 'terra.png', { type: 'image/png' });
                await navigator.share({ title, files: [file] });
              })
            : ''
        ])
      ]),
      wide: true
    });
  },

  help() {
    const keys = [
      ['W A S D / ← ↑ → ↓', L('Идти', 'Walk')],
      ['+ / −', L('Масштаб', 'Zoom')],
      ['T', L('Сменить стиль', 'Next theme')],
      ['M', L('Режим пелены', 'Next fog mode')],
      ['G', 'GPS'],
      ['C', L('Ко мне', 'Centre on me')],
      ['F', L('Поставить флажок', 'Drop a flag')],
      ['H', L('Тепловая карта', 'Heat map')],
      ['R', L('Трек', 'Track')],
      ['J', L('Журнал', 'Journal')],
      ['I', L('Статистика', 'Stats')],
      ['O', L('Настройки', 'Settings')],
      ['P', L('Поделиться', 'Share')],
      ['?', L('Эта справка', 'This help')]
    ];
    openDialog({
      title: L('Горячие клавиши', 'Keyboard shortcuts'),
      body: h(
        'dl',
        { class: 'hotkeys' },
        keys.flatMap(([k, v]) => [h('dt', {}, [h('kbd', {}, [k])]), h('dd', {}, [v])])
      )
    });
  },

  flag(app) {
    const title = /** @type {HTMLInputElement} */ (h('input', { type: 'text', placeholder: L('Название', 'Title'), maxlength: '80' }));
    const photo = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: 'image/*', capture: 'environment' }));
    openDialog({
      title: L('Метка здесь', 'Mark this place'),
      body: h('div', { class: 'form-grid' }, [field(L('Название', 'Title'), title), field(L('Фото (необязательно)', 'Photo (optional)'), photo)]),
      actions: [
        {
          label: L('Сохранить', 'Save'),
          kind: 'primary',
          run: async () => {
            const file = photo.files && photo.files[0];
            await app.notes.add({
              lat: app.player.lat,
              lng: app.player.lng,
              title: title.value.trim() || L('Флажок', 'Flag'),
              kind: file ? 'photo' : 'flag',
              photo: file || undefined
            });
            app.updateMarkers();
            app.renderer.requestDraw();
            toast(L('Метка поставлена', 'Marker placed'));
          }
        }
      ]
    });
    setTimeout(() => title.focus(), 50);
  },

  note(app, note) {
    const url = note.photo ? URL.createObjectURL(note.photo) : '';
    openDialog({
      title: note.title,
      body: h('div', {}, [
        url ? h('img', { class: 'share-preview', src: url, alt: note.title }) : '',
        h('p', { class: 'muted' }, [`${new Date(note.t).toLocaleString()} · ${note.lat.toFixed(5)}, ${note.lng.toFixed(5)}`])
      ]),
      actions: [
        {
          label: L('Удалить', 'Delete'),
          run: async () => {
            await app.notes.remove(note.id);
            app.updateMarkers();
            app.renderer.requestDraw();
          }
        }
      ],
      onClose: () => url && URL.revokeObjectURL(url)
    });
  }
};

/** @param {string} label @param {string} value */
function stat(label, value) {
  return h('div', {}, [h('dt', {}, [label]), h('dd', {}, [value])]);
}

// ---------- импорт, сравнение, резервные копии ----------

/** @param {any} app @param {'union' | 'replace' | 'subtract'} mode */
async function importAny(app, mode) {
  const file = await pickFile('.json,.gz,.geojson,.gpx,.kml,application/json,application/gzip');
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.gz')) {
    const n = await app.fog.importBlob(file, mode);
    toast(`${L('Импортировано чанков', 'Chunks imported')}: ${n}`, { action: { label: L('Отменить', 'Undo'), run: () => app.fog.undoImport().then(app.refreshAll) } });
  } else {
    const text = await file.text();
    if (/\.(gpx|kml|geojson)$/.test(name) || (name.endsWith('.json') && /"FeatureCollection"|"LineString"/.test(text.slice(0, 2000)))) {
      const parsed = parseTrackFile(file.name, text);
      let added = 0;
      for (const seg of parsed.segments) added += await app.fog.revealPath(seg, app.settings.get('radiusWalk'));
      for (const ring of parsed.polygons || []) added += await app.fog.revealRing(ring);
      await app.fog.flush();
      toast(`${L('Открыто клеток', 'Cells revealed')}: ${added}`);
    } else if (/terra-incognita-h3|^\s*\[\s*"8/.test(text.slice(0, 200))) {
      const h3 = await loadH3();
      const r = await app.fog.importH3(h3, text);
      toast(`H3: ${r.cells} → +${r.added}`);
    } else {
      const n = await app.fog.importJSON(text, mode);
      toast(`${L('Импортировано чанков', 'Chunks imported')}: ${n}`, { action: { label: L('Отменить', 'Undo'), run: () => app.fog.undoImport().then(app.refreshAll) } });
    }
  }
  app.refreshAll();
}

/** @param {any} app */
async function compareFriend(app) {
  const file = await pickFile('.json,.gz,application/json,application/gzip');
  if (!file) return;
  const friend = new FogStore({ factory: null, storage: null, broadcast: false, lruLimit: 100000 });
  await friend.importBlob(file, 'union');
  const r = await compareStores(app.fog, friend);
  app.renderer.compare = friend;
  app.renderer.compareCache.clear();
  app.renderer.requestDraw();
  const k = (/** @type {number} */ n) => n.toLocaleString();
  toast(`${L('Только у меня', 'Only mine')}: ${k(r.onlyMine)} · ${L('только у друга', 'only theirs')}: ${k(r.onlyTheirs)} · ${L('общие', 'shared')}: ${k(r.both)}`, {
    duration: 9000
  });
}

/** @param {any} app */
async function toggleChoropleth(app) {
  if (app.renderer.choropleth.length) {
    app.renderer.choropleth = [];
    app.renderer.requestDraw();
    return;
  }
  const level = app.area ? Math.min(10, app.area.level + 1) : 9;
  toast(L('Загружаю районы…', 'Loading districts…'));
  const areas = await fetchAreasIn(app.view.getBounds(), level);
  const list = [];
  for (const area of areas.slice(0, 40)) {
    const c = await areaCoverage(app.fog, area);
    list.push({ polygon: area.polygon, ratio: c.ratio, name: area.name });
  }
  app.renderer.choropleth = list;
  app.renderer.requestDraw();
  if (!list.length) toast(L('Районов не найдено', 'No districts found'));
}

/** @type {any} */
let backupHandle = null;
let backupTimer = /** @type {any} */ (null);

/** @param {any} app */
async function chooseBackupFile(app) {
  const w = /** @type {any} */ (window);
  if (!w.showSaveFilePicker) throw new Error(L('Браузер не поддерживает File System Access API', 'File System Access API is not supported'));
  backupHandle = await w.showSaveFilePicker({ suggestedName: 'terra-backup.json.gz', types: [{ description: 'Terra backup', accept: { 'application/gzip': ['.gz'] } }] });
  await writeBackup(app);
  scheduleBackup(app);
  toast(L('Бэкап записан', 'Backup written'));
}

/** @param {any} app */
async function writeBackup(app) {
  if (!backupHandle) return;
  const { blob } = await app.fog.exportBlob();
  const stream = await backupHandle.createWritable();
  await stream.write(blob);
  await stream.close();
}

/** @param {any} app */
function scheduleBackup(app) {
  clearInterval(backupTimer);
  const minutes = app.settings.get('autoBackupMinutes');
  if (!minutes || !backupHandle) return;
  backupTimer = setInterval(() => writeBackup(app).catch((e) => toast(`${L('Бэкап не удался', 'Backup failed')}: ${e.message}`, { kind: 'error' })), minutes * 60000);
}

/** @param {any} app */
function syncInput(app) {
  const el = /** @type {HTMLInputElement} */ (h('input', { type: 'url', placeholder: 'https://example.com/terra.json' }));
  el.value = app.settings.get('syncUrl');
  el.addEventListener('change', () => app.settings.set('syncUrl', el.value.trim()));
  return el;
}

/** Заготовка облачной синхронизации: PUT экспорта на указанный URL. @param {any} app */
async function syncPush(app) {
  const url = app.settings.get('syncUrl');
  if (!url) throw new Error(L('Укажите URL', 'Set a URL'));
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: await app.fog.exportJSON() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  toast(L('Отправлено', 'Pushed'));
}

/** Получение и объединение. @param {any} app */
async function syncPull(app) {
  const url = app.settings.get('syncUrl');
  if (!url) throw new Error(L('Укажите URL', 'Set a URL'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const n = await app.fog.importJSON(await res.text(), 'union');
  app.refreshAll();
  toast(`${L('Получено чанков', 'Chunks received')}: ${n}`);
}

// ---------- публичный API ----------

/** @param {any} app @param {string} name @param {any} [arg] */
export function openPanel(app, name, arg) {
  const panel = PANELS[name];
  if (panel) panel(app, arg);
}

/** @param {any} app */
export function setupPanels(app) {
  document.querySelectorAll('[data-panel]').forEach((el) => el.addEventListener('click', () => openPanel(app, /** @type {HTMLElement} */ (el).dataset.panel || '')));
  app.settings.onChange((/** @type {string} */ key) => {
    if (key === 'autoBackupMinutes') scheduleBackup(app);
  });
}

/** @param {any} app */
export function showOnboarding(app) {
  const steps = [
    [
      L('Мир под пеленой', 'A world under fog'),
      L(
        'Карта скрыта туманом. Он рассеивается там, где вы побывали, — и это сохраняется навсегда, прямо в браузере.',
        'The map is hidden by fog. It lifts wherever you have been — and stays lifted, stored in your browser.'
      )
    ],
    [
      L('Как двигаться', 'How to move'),
      L(
        'Включите GPS и гуляйте, или ходите клавишами WASD и кликами по карте. Импортируйте старые GPX-треки во вкладке «Данные».',
        'Turn on GPS and walk, or use WASD and map clicks. Import old GPX tracks from the Data panel.'
      )
    ],
    [
      L('Цели', 'Goals'),
      L(
        'Находите места из OpenStreetMap, открывайте районы, копите опыт и достижения. Клавиша ? покажет все горячие клавиши.',
        'Find OpenStreetMap places, uncover districts, earn XP and achievements. Press ? for all shortcuts.'
      )
    ]
  ];
  let i = 0;
  const heading = h('h3', {}, [steps[0][0]]);
  const text = h('p', {}, [steps[0][1]]);
  const dots = h('p', { class: 'muted' }, ['1 / 3']);
  /** @type {any} */
  let dialog = null;
  const next = h('button', { type: 'button', class: 'chip-button primary' }, [L('Дальше', 'Next')]);
  next.addEventListener('click', () => {
    i += 1;
    if (i >= steps.length) {
      app.settings.set('onboarded', true);
      if (dialog) dialog.close();
      return;
    }
    heading.textContent = steps[i][0];
    typewriter(text, steps[i][1]);
    dots.textContent = `${i + 1} / 3`;
    if (i === steps.length - 1) next.textContent = L('В путь', 'Let’s go');
  });
  dialog = openDialog({ title: 'Terra Incognita', body: h('div', { class: 'onboarding' }, [heading, text, dots, next]), onClose: () => app.settings.set('onboarded', true) });
}

/**
 * «Дописывание» текста, как подписи в макете хроники. Уважает prefers-reduced-motion.
 * @param {HTMLElement} el @param {string} text
 */
export function typewriter(el, text) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = text;
    return;
  }
  const token = String(Math.random());
  el.dataset.typing = token;
  let n = 0;
  const tick = () => {
    if (el.dataset.typing !== token) return;
    n += 1;
    el.textContent = text.slice(0, n);
    if (n < text.length) setTimeout(tick, 18);
  };
  tick();
}
