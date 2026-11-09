/**
 * Панели в модальных окнах. Декларативные (статистика, журнал, справка, знакомство) —
 * Forma-компоненты из ./views; формы с выбором, ползунками и файлами — Svet JSX,
 * потому что в Forma поверх Svet пока нет таких контролов.
 */
import { effect, signal, type Signal } from 'svet-engine';
import { openDialog, confirmTyped } from './dialog.tsx';
import { toast } from './toast.ts';
import { formaView } from './forma.ts';
import { ui, L, l } from './model.ts';
import { download, formatBytes, loadH3 } from '../util/load.js';
import { formatArea, formatDistance } from '../i18n.js';
import { ACHIEVEMENTS, levelFor, streetCoverage, compareStores, createReplayStore, areaCoverage } from '../game.js';
import { FogStore } from '../fog-store.js';
import { parseTrackFile, toGPX } from '../tracks.js';
import { fetchAreasIn, fetchStreets } from '../osm.js';
import createStats from './views/Stats.ui';
import createJournal from './views/Journal.ui';
import createHelp from './views/Help.ui';
import createOnboarding from './views/Onboarding.ui';

type AppState = any;
type Text = string | (() => string);

/** Сигнал, связанный с настройкой: правка пишет в Settings. */
function setting<T>(app: AppState, key: string): Signal<T> {
  const sig = signal<T>(app.settings.get(key));
  let first = true;
  effect(() => {
    const value = sig();
    if (first) {
      first = false;
      return;
    }
    app.settings.set(key, value);
  });
  return sig;
}

function Field(props: { label: Text; children?: any }): Node {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function Select(props: { app: AppState; name: string; options: Array<[string, Text]> }): Node {
  const value = setting<string>(props.app, props.name);
  const el = (
    <select model={value}>
      {props.options.map(([option, text]) => (
        <option value={option}>{text}</option>
      ))}
    </select>
  ) as HTMLSelectElement;
  // model привязывается раньше, чем появляются <option>, поэтому выбор выставляем после сборки
  el.value = value.peek();
  return el;
}

function Range(props: { app: AppState; name: string; min: number; max: number; step: number }): Node {
  const value = setting<number>(props.app, props.name);
  return (
    <span class="range">
      <input type="range" min={props.min} max={props.max} step={props.step} model={value} />
      <output>{value}</output>
    </span>
  );
}

function Check(props: { app: AppState; name: string }): Node {
  return <input type="checkbox" model={setting<boolean>(props.app, props.name)} />;
}

function Action(props: { label: Text; run: () => unknown; kind?: string }): Node {
  const busy = signal(false);
  return (
    <button
      type="button"
      class={`chip-button ${props.kind || ''}`}
      aria-busy={() => (busy() ? 'true' : false)}
      onClick={async () => {
        busy.set(true);
        try {
          await props.run();
        } catch (error) {
          toast(String((error as Error).message || error), { kind: 'error' });
        } finally {
          busy.set(false);
        }
      }}
    >
      {props.label}
    </button>
  );
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null));
    input.click();
  });
}

const stamp = () => new Date().toISOString().slice(0, 10);

// ---------- панели ----------

const PANELS: Record<string, (app: AppState, arg?: any) => void> = {
  settings(app) {
    const usage = signal('…');
    app.fog.estimate().then((e: any) => {
      usage.set(
        e
          ? `${l('Занято', 'Used')}: ${formatBytes(e.usage || 0)} / ${formatBytes(e.quota || 0)} · ${
              e.persisted ? l('постоянное хранилище', 'persistent storage') : l('хранилище может быть очищено браузером', 'storage may be evicted')
            }`
          : '—'
      );
    });
    openDialog({
      title: L('Настройки', 'Settings'),
      wide: true,
      body: () => {
        const syncUrl = setting<string>(app, 'syncUrl');
        return (
          <div class="form-grid">
            <h3>{L('Пелена', 'Fog')}</h3>
            <Field label={L('Стиль', 'Theme')}>
              <Select
                app={app}
                name="theme"
                options={[
                  ['terra', 'Terra Incognita'],
                  ['heroes', 'Heroes III'],
                  ['western', 'Red Dead']
                ]}
              />
            </Field>
            <Field label={L('Интерфейс', 'Interface')}>
              <Select
                app={app}
                name="ui"
                options={[
                  ['classic', L('Классический', 'Classic')],
                  ['heroes', 'Heroes'],
                  ['reddead', 'Red Dead']
                ]}
              />
            </Field>
            <Field label={L('Режим пелены', 'Fog mode')}>
              <Select
                app={app}
                name="fogMode"
                options={[
                  ['classic', L('Классика', 'Classic')],
                  ['heroes4', 'Heroes IV'],
                  ['redalert', 'Red Alert'],
                  ['moba', 'MOBA'],
                  ['hex', L('Гексы', 'Hexes')]
                ]}
              />
            </Field>
            <Field label={L('Радиус (вручную), м', 'Radius (manual), m')}>
              <Range app={app} name="radius" min={10} max={120} step={5} />
            </Field>
            <Field label={L('Обзор Heroes IV, м', 'Heroes IV vision, m')}>
              <Range app={app} name="visionMeters" min={40} max={400} step={10} />
            </Field>
            <Field label={L('Отрастание Red Alert, дней', 'Red Alert regrow, days')}>
              <Range app={app} name="regrowDays" min={1} max={365} step={1} />
            </Field>
            <Field label={L('Гекс, м', 'Hex size, m')}>
              <Range app={app} name="hexMeters" min={10} max={200} step={5} />
            </Field>

            <h3>GPS</h3>
            <Field label={L('Ввод', 'Input')}>
              <Select
                app={app}
                name="input"
                options={[
                  ['manual', L('Вручную', 'Manual')],
                  ['gps', 'GPS']
                ]}
              />
            </Field>
            <Field label={L('Пешком, м', 'Walking, m')}>
              <Range app={app} name="radiusWalk" min={10} max={80} step={5} />
            </Field>
            <Field label={L('Велосипед, м', 'Bike, m')}>
              <Range app={app} name="radiusBike" min={5} max={60} step={5} />
            </Field>
            <Field label={L('Авто, м', 'Car, m')}>
              <Range app={app} name="radiusCar" min={5} max={40} step={5} />
            </Field>
            <Field label={L('Камера следует', 'Follow camera')}>
              <Check app={app} name="follow" />
            </Field>

            <h3>{L('Карта', 'Map')}</h3>
            <Field label={L('Подложка', 'Basemap')}>
              <Select
                app={app}
                name="basemap"
                options={[
                  ['raster', L('Растр OSM', 'OSM raster')],
                  ['vector', L('Вектор (MapLibre)', 'Vector (MapLibre)')]
                ]}
              />
            </Field>
            <Field label={L('Ночь', 'Night')}>
              <Select
                app={app}
                name="night"
                options={[
                  ['auto', L('По закату', 'By sunset')],
                  ['on', L('Всегда', 'Always')],
                  ['off', L('Выкл.', 'Off')]
                ]}
              />
            </Field>
            <Field label={L('Трек', 'Track')}>
              <Check app={app} name="showTrack" />
            </Field>
            <Field label={L('Тепловая карта', 'Heat map')}>
              <Check app={app} name="showHeat" />
            </Field>
            <Field label={L('Язык', 'Language')}>
              <Select
                app={app}
                name="lang"
                options={[
                  ['ru', 'Русский'],
                  ['en', 'English']
                ]}
              />
            </Field>
            <Field label={L('Стартовая точка', 'Start point')}>
              <Action
                label={L('Текущий центр карты', 'Current map centre')}
                run={() => {
                  const c = app.view.getCenter();
                  app.settings.set('start', { lat: c.lat, lng: c.lng });
                  toast(l('Стартовая точка сохранена', 'Start point saved'));
                }}
              />
            </Field>
            <Field label={L('Отладка', 'Debug')}>
              <Check app={app} name="debug" />
            </Field>

            <h3>{L('Резервные копии', 'Backups')}</h3>
            <Field label={L('Автобэкап, мин (0 — выкл.)', 'Auto-backup, min (0 = off)')}>
              <Range app={app} name="autoBackupMinutes" min={0} max={240} step={15} />
            </Field>
            <Field label={L('Файл бэкапа', 'Backup file')}>
              <Action label={L('Выбрать…', 'Choose…')} run={() => chooseBackupFile(app)} />
            </Field>
            <Field label={L('URL синхронизации', 'Sync URL')}>
              <input type="url" placeholder="https://example.com/terra.json" model={syncUrl} />
            </Field>
            <div class="row">
              <Action label={L('Отправить', 'Push')} run={() => syncPush(app)} />
              <Action label={L('Получить', 'Pull')} run={() => syncPull(app)} />
            </div>

            <h3>{L('Хранилище', 'Storage')}</h3>
            <p class="muted">{usage}</p>
            <Action
              label={L('Запросить постоянное хранение', 'Request persistent storage')}
              run={async () => {
                const ok = await app.fog.requestPersistence();
                toast(ok ? l('Браузер не будет удалять данные', 'Data will not be evicted') : l('Браузер отказал', 'Browser declined'));
              }}
            />
          </div>
        );
      }
    });
  },

  data(app) {
    const mode = signal<'union' | 'replace' | 'subtract'>('union');
    openDialog({
      title: L('Данные', 'Data'),
      wide: true,
      body: () => (
        <div class="form-grid">
          <h3>{L('Экспорт', 'Export')}</h3>
          <div class="row">
            <Action
              label={L('Пелена (.json.gz)', 'Fog (.json.gz)')}
              run={async () => {
                const { blob, gzip } = await app.fog.exportBlob();
                download(`terra-fog-${stamp()}.json${gzip ? '.gz' : ''}`, blob);
              }}
            />
            <Action
              label="H3"
              run={async () => {
                const h3 = await loadH3();
                download(`terra-h3-${stamp()}.json`, await app.fog.exportH3(h3, 11), 'application/json');
              }}
            />
            <Action label="GeoJSON" run={async () => download(`terra-${stamp()}.geojson`, await app.fog.exportGeoJSON(), 'application/geo+json')} />
            <Action label="GPX" run={() => download(`terra-tracks-${stamp()}.gpx`, toGPX(app.tracks.allSegments()), 'application/gpx+xml')} />
          </div>

          <h3>{L('Импорт', 'Import')}</h3>
          <Field label={L('Режим слияния пелены', 'Fog merge mode')}>
            <select model={mode}>
              <option value="union">{L('Объединить', 'Union')}</option>
              <option value="replace">{L('Заменить', 'Replace')}</option>
              <option value="subtract">{L('Вычесть', 'Subtract')}</option>
            </select>
          </Field>
          <div class="row">
            <Action label={L('Файл…', 'File…')} run={() => importAny(app, mode.peek())} />
            <Action
              label={L('Отменить импорт', 'Undo import')}
              run={async () => {
                const ok = await app.fog.undoImport();
                toast(ok ? l('Импорт отменён', 'Import undone') : l('Нечего отменять', 'Nothing to undo'));
                app.refreshAll();
              }}
            />
          </div>
          <p class="muted">{L('Поддерживаются: экспорт пелены (.json, .gz), H3, GPX, KML, GeoJSON.', 'Supported: fog export (.json, .gz), H3, GPX, KML, GeoJSON.')}</p>

          <h3>{L('Сравнение с другом', 'Compare with a friend')}</h3>
          <div class="row">
            <Action label={L('Открыть файл друга…', 'Open friend’s file…')} run={() => compareFriend(app)} />
            <Action
              label={L('Скрыть', 'Hide')}
              run={() => {
                app.renderer.compare = null;
                app.renderer.compareCache.clear();
                app.renderer.requestDraw();
              }}
            />
          </div>

          <h3 class="danger-text">{L('Опасная зона', 'Danger zone')}</h3>
          <Action
            kind="danger"
            label={L('Стереть всё', 'Erase everything')}
            run={async () => {
              const ok = await confirmTyped({
                title: l('Стереть карту?', 'Erase the map?'),
                text: l(
                  'Будут удалены пелена, треки и метки. Экспортируйте данные заранее. Для подтверждения введите «стереть».',
                  'Fog, tracks and notes will be deleted. Export first. Type “erase” to confirm.'
                ),
                word: l('стереть', 'erase')
              });
              if (!ok) return;
              await app.fog.clear();
              await app.tracks.clear();
              for (const note of app.notes.list()) await app.notes.remove(note.id);
              app.game.reset();
              app.updateMarkers();
              app.refreshAll();
              toast(l('Карта очищена', 'Map erased'));
            }}
          />
        </div>
      )
    });
  },

  stats(app) {
    const g = app.game;
    const lv = levelFor(g.state.xp);
    const best = g.bestDay();
    const en = ui.locale.peek() === 'en';
    const tiles = signal([
      { label: l('Площадь', 'Area'), value: formatArea(app.fog.revealedArea(app.player.lat)) },
      { label: l('Клеток', 'Cells'), value: app.fog.totalCells.toLocaleString() },
      { label: l('Пройдено', 'Walked'), value: formatDistance(app.tracks.totalMeters()) },
      { label: l('Уровень', 'Level'), value: `${lv.level} · ${g.state.xp} XP` },
      { label: l('Сегодня', 'Today'), value: `+${g.today()}` },
      { label: l('За неделю', 'This week'), value: `+${g.week()}` },
      { label: l('Серия дней', 'Streak'), value: String(g.streak()) },
      { label: l('Лучший день', 'Best day'), value: best.cells ? `${best.day} · +${best.cells}` : '—' },
      { label: l('Находки', 'Finds'), value: String(Object.keys(g.state.pois).length) }
    ]);
    const achievements = signal(ACHIEVEMENTS.map((a) => ({ id: a.id, icon: a.icon, name: en ? a.nameEn : a.name, unlocked: Boolean(g.state.achievements[a.id]) })));
    const coverage = signal(app.area && app.areaCoverage ? `${app.area.name}: ${(app.areaCoverage.ratio * 100).toFixed(2)}%` : l('Район не определён', 'District unknown'));
    const streets = signal('');
    const busy = signal(false);
    const guarded = async (fn: () => unknown) => {
      busy.set(true);
      try {
        await fn();
      } catch (error) {
        toast(String((error as Error).message || error), { kind: 'error' });
      } finally {
        busy.set(false);
      }
    };
    openDialog({
      title: L('Статистика', 'Statistics'),
      wide: true,
      body: () =>
        formaView(createStats, {
          viewModel: { tiles, achievements, coverage, streets, busy },
          events: {
            streets: () =>
              guarded(async () => {
                if (!app.area) throw new Error(l('Район не определён', 'District unknown'));
                streets.set(l('Загружаю улицы…', 'Loading streets…'));
                const list = await fetchStreets(app.area, 25);
                const r = await streetCoverage(app.fog, list);
                streets.set(`${l('Пройдено улиц', 'Streets done')}: ${r.done} / ${r.total}`);
              }),
            choropleth: () => guarded(() => toggleChoropleth(app)),
            challenge: () =>
              guarded(() => {
                if (!app.area || !app.areaCoverage) throw new Error(l('Район не определён', 'District unknown'));
                g.startChallenge(app.area, app.areaCoverage.revealed, app.areaCoverage.total, 5);
                toast(l('Испытание началось', 'Challenge started'));
                app.refreshAll();
              })
          }
        })
    });
  },

  journal(app) {
    const rows = signal(
      app.game.journal(app.tracks.days).map((r: any) => ({
        day: r.day,
        summary: `+${r.cells} ${l('клеток', 'cells')} · ${formatDistance(r.meters)}`,
        places: r.pois.join(', ')
      }))
    );
    openDialog({ title: L('Журнал экспедиции', 'Expedition journal'), body: () => formaView(createJournal, { viewModel: { rows } }) });
  },

  timeline(app) {
    const days: string[] = [...app.tracks.days.keys()].sort();
    if (!days.length) {
      openDialog({
        title: L('Хроника', 'Timeline'),
        body: () => <p class="muted">{L('Нет треков для воспроизведения. Включите GPS или импортируйте GPX.', 'No tracks to replay. Enable GPS or import GPX.')}</p>
      });
      return;
    }
    let replay = createReplayStore(FogStore);
    const index = signal(0);
    let shown = -1;
    let chain: Promise<void> = Promise.resolve();
    const showUntil = (target: number) => {
      chain = chain.then(async () => {
        if (target < shown) {
          replay = createReplayStore(FogStore);
          shown = -1;
        }
        for (let i = shown + 1; i <= target; i += 1) {
          for (const seg of app.tracks.segments(days[i])) await replay.revealPath(seg, app.settings.get('radiusWalk'));
        }
        replay.chunks.forEach((chunk: any) => chunk.showAll());
        shown = target;
        app.renderer.source = replay;
        app.renderer.cache.clear();
        app.renderer.requestDraw();
      });
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    openDialog({
      title: L('Хроника открытий', 'Discovery timeline'),
      body: () => {
        effect(() => showUntil(index()));
        return (
          <div class="form-grid">
            <Field label={L('День', 'Day')}>
              <span class="range">
                <input type="range" min={0} max={days.length - 1} step={1} model={index} />
                <output>{() => days[index()]}</output>
              </span>
            </Field>
            <Action
              label={L('▶ Воспроизвести', '▶ Play')}
              run={() => {
                clearInterval(timer);
                index.set(0);
                timer = setInterval(() => {
                  if (index.peek() + 1 >= days.length) return clearInterval(timer);
                  index.update((i) => i + 1);
                }, 700);
              }}
            />
          </div>
        );
      },
      onClose: () => {
        clearInterval(timer);
        chain.then(() => {
          app.renderer.source = app.fog;
          app.renderer.cache.clear();
          app.renderer.requestDraw();
        });
      }
    });
  },

  share(app) {
    const title = `Terra Incognita · ${formatArea(app.fog.revealedArea(app.player.lat))} · ${stamp()}`;
    const canvas: HTMLCanvasElement = app.renderer.compose(app.basemapFilter(), title);
    const toBlob = () => new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
    openDialog({
      title: L('Поделиться картой', 'Share the map'),
      wide: true,
      body: () => (
        <div>
          <img class="share-preview" alt={title} src={canvas.toDataURL('image/png')} />
          <div class="row">
            <Action label={L('Скачать PNG', 'Download PNG')} run={async () => download(`terra-${stamp()}.png`, await toBlob())} />
            {typeof navigator.share === 'function' ? (
              <Action
                label={L('Поделиться…', 'Share…')}
                run={async () => {
                  const file = new File([await toBlob()], 'terra.png', { type: 'image/png' });
                  await navigator.share({ title, files: [file] });
                }}
              />
            ) : null}
          </div>
        </div>
      )
    });
  },

  help() {
    const keys = signal([
      { combo: 'W A S D / ← ↑ → ↓', label: l('Идти', 'Walk') },
      { combo: '+ / −', label: l('Масштаб', 'Zoom') },
      { combo: 'T', label: l('Сменить стиль', 'Next theme') },
      { combo: 'M', label: l('Режим пелены', 'Next fog mode') },
      { combo: 'G', label: 'GPS' },
      { combo: 'C', label: l('Ко мне', 'Centre on me') },
      { combo: 'F', label: l('Поставить флажок', 'Drop a flag') },
      { combo: 'H', label: l('Тепловая карта', 'Heat map') },
      { combo: 'R', label: l('Трек', 'Track') },
      { combo: 'J', label: l('Журнал', 'Journal') },
      { combo: 'I', label: l('Статистика', 'Stats') },
      { combo: 'O', label: l('Настройки', 'Settings') },
      { combo: 'P', label: l('Поделиться', 'Share') },
      { combo: '?', label: l('Эта справка', 'This help') }
    ]);
    openDialog({ title: L('Горячие клавиши', 'Keyboard shortcuts'), body: () => formaView(createHelp, { viewModel: { keys } }) });
  },

  flag(app) {
    const title = signal('');
    let photo!: HTMLInputElement;
    let input!: HTMLInputElement;
    openDialog({
      title: L('Метка здесь', 'Mark this place'),
      body: () => (
        <div class="form-grid">
          <Field label={L('Название', 'Title')}>
            <input type="text" maxlength="80" model={title} ref={(el: HTMLInputElement) => (input = el)} />
          </Field>
          <Field label={L('Фото (необязательно)', 'Photo (optional)')}>
            <input type="file" accept="image/*" capture="environment" ref={(el: HTMLInputElement) => (photo = el)} />
          </Field>
        </div>
      ),
      actions: [
        {
          label: L('Сохранить', 'Save'),
          kind: 'primary',
          run: async () => {
            const file = photo.files && photo.files[0];
            await app.notes.add({
              lat: app.player.lat,
              lng: app.player.lng,
              title: title.peek().trim() || l('Флажок', 'Flag'),
              kind: file ? 'photo' : 'flag',
              photo: file || undefined
            });
            app.updateMarkers();
            app.renderer.requestDraw();
            toast(l('Метка поставлена', 'Marker placed'));
          }
        }
      ]
    });
    input.focus();
  },

  note(app, note) {
    const url = note.photo ? URL.createObjectURL(note.photo) : '';
    openDialog({
      title: note.title,
      body: () => (
        <div>
          {url ? <img class="share-preview" src={url} alt={note.title} /> : null}
          <p class="muted">{`${new Date(note.t).toLocaleString()} · ${note.lat.toFixed(5)}, ${note.lng.toFixed(5)}`}</p>
        </div>
      ),
      actions: [
        {
          label: L('Удалить', 'Delete'),
          kind: 'danger',
          run: async () => {
            await app.notes.remove(note.id);
            app.updateMarkers();
            app.renderer.requestDraw();
          }
        },
        { label: L('Закрыть', 'Close') }
      ],
      onClose: () => {
        if (url) URL.revokeObjectURL(url);
      }
    });
  }
};

// ---------- импорт, сравнение, резервные копии ----------

async function importAny(app: AppState, mode: 'union' | 'replace' | 'subtract'): Promise<void> {
  const file = await pickFile('.json,.gz,.geojson,.gpx,.kml,application/json,application/gzip');
  if (!file) return;
  const name = file.name.toLowerCase();
  const undo = { label: l('Отменить', 'Undo'), run: () => app.fog.undoImport().then(app.refreshAll) };
  if (name.endsWith('.gz')) {
    const n = await app.fog.importBlob(file, mode);
    toast(`${l('Импортировано чанков', 'Chunks imported')}: ${n}`, { action: undo });
  } else {
    const text = await file.text();
    if (/\.(gpx|kml|geojson)$/.test(name) || (name.endsWith('.json') && /"FeatureCollection"|"LineString"/.test(text.slice(0, 2000)))) {
      const parsed = parseTrackFile(file.name, text);
      let added = 0;
      for (const seg of parsed.segments) added += await app.fog.revealPath(seg, app.settings.get('radiusWalk'));
      for (const ring of parsed.polygons || []) added += await app.fog.revealRing(ring);
      app.fog.chunks.forEach((chunk: any) => chunk.showAll());
      await app.fog.flush();
      toast(`${l('Открыто клеток', 'Cells revealed')}: ${added}`);
    } else if (/terra-incognita-h3|^\s*\[\s*"8/.test(text.slice(0, 200))) {
      const h3 = await loadH3();
      const r = await app.fog.importH3(h3, text);
      toast(`H3: ${r.cells} → +${r.added}`);
    } else {
      const n = await app.fog.importJSON(text, mode);
      toast(`${l('Импортировано чанков', 'Chunks imported')}: ${n}`, { action: undo });
    }
  }
  app.refreshAll();
}

async function compareFriend(app: AppState): Promise<void> {
  const file = await pickFile('.json,.gz,application/json,application/gzip');
  if (!file) return;
  const friend = new FogStore({ factory: null, storage: null, broadcast: false, lruLimit: 100000 });
  await friend.importBlob(file, 'union');
  const r = await compareStores(app.fog, friend);
  app.renderer.compare = friend;
  app.renderer.compareCache.clear();
  app.renderer.requestDraw();
  const k = (n: number) => n.toLocaleString();
  toast(`${l('Только у меня', 'Only mine')}: ${k(r.onlyMine)} · ${l('только у друга', 'only theirs')}: ${k(r.onlyTheirs)} · ${l('общие', 'shared')}: ${k(r.both)}`, {
    duration: 9000
  });
}

async function toggleChoropleth(app: AppState): Promise<void> {
  if (app.renderer.choropleth.length) {
    app.renderer.choropleth = [];
    app.renderer.requestDraw();
    return;
  }
  const level = app.area ? Math.min(10, app.area.level + 1) : 9;
  toast(l('Загружаю районы…', 'Loading districts…'));
  const areas = await fetchAreasIn(app.view.getBounds(), level);
  const list = [];
  for (const area of areas.slice(0, 40)) {
    const c = await areaCoverage(app.fog, area);
    list.push({ polygon: area.polygon, ratio: c.ratio, name: area.name });
  }
  app.renderer.choropleth = list;
  app.renderer.requestDraw();
  if (!list.length) toast(l('Районов не найдено', 'No districts found'));
}

let backupHandle: any = null;
let backupTimer: ReturnType<typeof setInterval> | undefined;

async function chooseBackupFile(app: AppState): Promise<void> {
  const w = window as any;
  if (!w.showSaveFilePicker) throw new Error(l('Браузер не поддерживает File System Access API', 'File System Access API is not supported'));
  backupHandle = await w.showSaveFilePicker({ suggestedName: 'terra-backup.json.gz', types: [{ description: 'Terra backup', accept: { 'application/gzip': ['.gz'] } }] });
  await writeBackup(app);
  scheduleBackup(app);
  toast(l('Бэкап записан', 'Backup written'));
}

async function writeBackup(app: AppState): Promise<void> {
  if (!backupHandle) return;
  const { blob } = await app.fog.exportBlob();
  const stream = await backupHandle.createWritable();
  await stream.write(blob);
  await stream.close();
}

function scheduleBackup(app: AppState): void {
  clearInterval(backupTimer);
  const minutes = app.settings.get('autoBackupMinutes');
  if (!minutes || !backupHandle) return;
  backupTimer = setInterval(() => writeBackup(app).catch((e) => toast(`${l('Бэкап не удался', 'Backup failed')}: ${e.message}`, { kind: 'error' })), minutes * 60000);
}

/** Заготовка облачной синхронизации: PUT экспорта на указанный URL. */
async function syncPush(app: AppState): Promise<void> {
  const url = app.settings.get('syncUrl');
  if (!url) throw new Error(l('Укажите URL', 'Set a URL'));
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: await app.fog.exportJSON() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  toast(l('Отправлено', 'Pushed'));
}

async function syncPull(app: AppState): Promise<void> {
  const url = app.settings.get('syncUrl');
  if (!url) throw new Error(l('Укажите URL', 'Set a URL'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const n = await app.fog.importJSON(await res.text(), 'union');
  app.refreshAll();
  toast(`${l('Получено чанков', 'Chunks received')}: ${n}`);
}

// ---------- публичный API ----------

export function openPanel(app: AppState, name: string, arg?: unknown): void {
  const panel = PANELS[name];
  if (panel) panel(app, arg);
}

export function setupPanels(app: AppState): void {
  app.settings.onChange((key: string) => {
    if (key === 'autoBackupMinutes') scheduleBackup(app);
  });
}

export function showOnboarding(app: AppState): void {
  const dialog = openDialog({
    title: 'Terra Incognita',
    body: () => formaView(createOnboarding, { events: { done: () => dialog.close() } }),
    actions: [],
    onClose: () => app.settings.set('onboarded', true)
  });
}
