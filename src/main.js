// @ts-check
/**
 * Точка входа: связывает хранилище, карту, рендер пелены, GPS, треки,
 * игровой слой и интерфейс.
 */
import { FogStore } from './fog-store.js';
import { TrackStore } from './tracks.js';
import { NotesStore, MarkerLayer } from './markers.js';
import { GpsTracker, radiusForSpeed } from './gps.js';
import { Settings } from './settings.js';
import { Game, levelFor, nextQuest, nearestUnexplored, areaCoverage } from './game.js';
import { fetchPois, fetchAreasAt } from './osm.js';
import { distance, dayKey, sunTimes, metersToLatitude, metersToLongitude } from './geo.js';
import { LeafletView } from './map/leaflet-view.js';
import { MapLibreView } from './map/maplibre-view.js';
import { FogRenderer } from './render/fog-renderer.js';
import { Minimap } from './ui/minimap.js';
import { toast } from './ui/toast.js';
import { setLang, applyI18n, t, formatDistance, formatArea, compassDirection, getLang } from './i18n.js';
import { $ } from './util/load.js';
import { setupPanels, openPanel, showOnboarding, typewriter } from './ui/panels.js';

const PLAYER_KEY = 'terra-player';
const VIEW_KEY = 'terra-view';
const STEP_METERS = 30;
const DISCOVERY_METERS = 60;
const POI_FETCH_RADIUS = 1500;
const THEME_FILTERS = {
  terra: 'saturate(.72) sepia(.12)',
  heroes: 'saturate(1.28) sepia(.18) contrast(1.18)',
  western: 'saturate(.35) sepia(.82) contrast(1.12) brightness(1.08)'
};
const NIGHT_FILTER = ' brightness(.62) contrast(1.08) saturate(.7) hue-rotate(-8deg)';

const settings = new Settings();
setLang(settings.get('lang'));
applyI18n();

const fog = new FogStore();
const game = new Game();

/**
 * Общее состояние приложения, доступное панелям.
 * @type {any}
 */
const app = {
  settings,
  fog,
  game,
  /** @type {TrackStore} */ tracks: /** @type {any} */ (null),
  /** @type {NotesStore} */ notes: /** @type {any} */ (null),
  view: /** @type {any} */ (null),
  /** @type {FogRenderer} */ renderer: /** @type {any} */ (null),
  /** @type {MarkerLayer} */ markers: /** @type {any} */ (null),
  /** @type {Minimap | null} */ minimap: null,
  /** @type {GpsTracker} */ gps: /** @type {any} */ (null),
  player: loadPlayer(),
  /** @type {import('./osm.js').Poi[]} */ pois: [],
  /** @type {import('./osm.js').Area | null} */ area: null,
  areaCoverage: /** @type {null | {revealed: number, total: number, ratio: number}} */ (null),
  lastRevealKey: '',
  basemapFilter,
  applyTheme,
  revealAt,
  movePlayer,
  refreshAll,
  updateMarkers,
  recreateView,
  centerOnPlayer,
  toggleGps
};
/** @type {any} */ (window).terra = app;

function loadPlayer() {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_KEY) || 'null');
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) return { lat: saved.lat, lng: saved.lng };
  } catch (error) {
    /* нет сохранённой позиции */
  }
  const start = settings.get('start');
  return { lat: start.lat, lng: start.lng };
}

function savePlayer() {
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(app.player));
  } catch (error) {
    /* нет места */
  }
}

// ---------- карта и тема ----------

function isNight() {
  const mode = settings.get('night');
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const times = sunTimes(new Date(), app.player.lat, app.player.lng);
  if (!times) return false;
  const now = Date.now();
  return now < times.sunrise || now > times.sunset;
}

function basemapFilter() {
  const theme = settings.get('theme');
  return (THEME_FILTERS[/** @type {'terra'} */ (theme)] || THEME_FILTERS.terra) + (isNight() ? NIGHT_FILTER : '');
}

/** @param {string} theme @param {boolean} [fade] */
function applyTheme(theme, fade = true) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.night = String(isNight());
  document.querySelectorAll('.theme-button').forEach((b) => b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.theme === theme)));
  if (app.view) {
    app.view.setFilter(basemapFilter());
    if (app.view.setTheme) app.view.setTheme(theme, isNight());
  }
  if (app.renderer) {
    if (fade) app.renderer.crossfade();
    app.renderer.requestDraw();
  }
}

/** @param {any} saved */
async function createView(saved) {
  const container = $('#map');
  const initial = saved || { lat: app.player.lat, lng: app.player.lng, zoom: 15 };
  if (settings.get('basemap') === 'vector') {
    try {
      return await MapLibreView.create(container, initial, settings.get('theme'));
    } catch (error) {
      toast(`Векторная карта недоступна: ${/** @type {Error} */ (error).message}. Включена растровая.`, { kind: 'warn' });
    }
  }
  return new LeafletView(container, initial);
}

async function recreateView() {
  const saved = app.view ? { ...app.view.getCenter(), zoom: app.view.getZoom() } : null;
  if (app.view) app.view.destroy();
  $('#map').innerHTML = '';
  app.view = await createView(saved);
  wireView();
  app.renderer.view = app.view;
  app.markers.view = app.view;
  applyTheme(settings.get('theme'), false);
  refreshAll();
}

let tileErrors = 0;
let tileWarned = false;
function wireView() {
  const view = app.view;
  view.on('move', onViewChange);
  view.on('resize', onViewChange);
  view.on('zoom', () => {
    $('#zoom-level').textContent = `z${view.getZoom().toFixed(1).replace(/\.0$/, '')}`;
    onViewChange();
  });
  view.on('click', (/** @type {{lat: number, lng: number}} */ e) => {
    if (settings.get('input') === 'gps' && app.gps && app.gps.active) return;
    movePlayer(e.lat, e.lng, { teleport: true });
  });
  view.on('tileerror', () => {
    tileErrors += 1;
    setTimeout(() => {
      tileErrors = Math.max(0, tileErrors - 1);
    }, 15000);
    if (tileErrors >= 8 && !tileWarned) {
      tileWarned = true;
      toast(t('tiles.error'), { kind: 'warn', duration: 9000 });
    }
  });
  view.on('tileload', () => {
    tileWarned = tileErrors > 0 ? tileWarned : false;
  });
  $('#zoom-level').textContent = `z${Math.round(view.getZoom())}`;
}

let viewSaveTimer = /** @type {any} */ (null);
let minimapTimer = /** @type {any} */ (null);
function onViewChange() {
  app.renderer.requestDraw();
  updatePlayerMarker();
  app.markers.update();
  if (!minimapTimer) {
    minimapTimer = setTimeout(() => {
      minimapTimer = null;
      if (app.minimap) app.minimap.update();
    }, 250);
  }
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ ...app.view.getCenter(), zoom: app.view.getZoom() }));
    } catch (error) {
      /* нет места */
    }
  }, 600);
}

function updatePlayerMarker() {
  const p = app.view.project(app.player.lat, app.player.lng);
  const el = $('#player');
  el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  app.renderer.player = app.player;
}

function centerOnPlayer() {
  app.view.panTo(app.player.lat, app.player.lng);
}

// ---------- открытие и перемещение ----------

/**
 * @param {number} lat @param {number} lng @param {number} radius
 * @param {{ animate?: boolean, from?: {lat: number, lng: number} | null }} [options]
 */
async function revealAt(lat, lng, radius, options = {}) {
  const animate = options.animate !== false;
  let added = 0;
  if (options.from && distance(options.from.lat, options.from.lng, lat, lng) > radius) {
    added += await fog.revealPath([options.from, { lat, lng }], radius);
    fog.chunks.forEach((chunk) => chunk.showAll());
  }
  await fog.ensureAround(lat, lng, radius);
  const cells = fog.reveal(lat, lng, radius);
  added += cells.length;
  if (cells.length) {
    if (animate) {
      app.renderer.addSpot({
        id: `${lat.toFixed(6)},${lng.toFixed(6)}`,
        lat,
        lng,
        cells,
        radius,
        createdAt: performance.now(),
        duration: settings.get('theme') === 'heroes' ? 180 : 760
      });
    } else {
      cells.forEach((cell) => cell.chunk.show(cell.index));
    }
  }
  if (added) {
    game.recordReveal(added);
    afterReveal(added);
  }
  app.renderer.requestDraw();
  return added;
}

let persistAsked = false;
let coverageTimer = /** @type {any} */ (null);
/** @param {number} added */
function afterReveal(added) {
  updateProgress();
  updateLevel();
  app.markers.update();
  if (!persistAsked) {
    persistAsked = true;
    fog.requestPersistence().then((ok) => {
      if (ok) toast(t('storage.persisted'), { kind: 'ok' });
    });
  }
  clearTimeout(coverageTimer);
  coverageTimer = setTimeout(async () => {
    if (app.area) app.areaCoverage = await areaCoverage(fog, app.area);
    updateProgress();
    game.checkAchievements({
      area: fog.revealedArea(app.player.lat),
      added,
      hour: new Date().getHours(),
      chunks: fog.index.size,
      coverage: app.areaCoverage ? app.areaCoverage.ratio : 0
    });
  }, 1500);
}

/**
 * @param {number} lat @param {number} lng
 * @param {{ teleport?: boolean, radius?: number, source?: 'gps' | 'manual', acc?: number, pan?: boolean }} [options]
 */
async function movePlayer(lat, lng, options = {}) {
  const prev = { ...app.player };
  app.player = { lat, lng };
  savePlayer();
  if (options.teleport) app.tracks.breakSegment();
  app.tracks.add({ t: Date.now(), lat, lng, acc: options.acc, src: options.source || 'manual' });
  if (options.pan !== false && (settings.get('follow') || options.source !== 'gps')) app.view.panTo(lat, lng);
  updatePlayerMarker();
  updatePosition();
  const radius = options.radius || settings.get('radius');
  await revealAt(lat, lng, radius, { from: options.teleport ? null : prev });
  checkPois();
  updateQuest();
}

/** @param {number} dx @param {number} dy */
function step(dx, dy) {
  const lat = app.player.lat - dy * metersToLatitude(STEP_METERS);
  const lng = app.player.lng + dx * metersToLongitude(STEP_METERS, lat);
  movePlayer(lat, lng);
}

// ---------- GPS ----------

function setupGps() {
  app.gps = new GpsTracker({
    onFix: (fix) => {
      const radii = { walk: settings.get('radiusWalk'), bike: settings.get('radiusBike'), car: settings.get('radiusCar') };
      movePlayer(fix.lat, fix.lng, { radius: radiusForSpeed(fix.speed, radii), source: 'gps', acc: fix.acc, pan: settings.get('follow') });
    },
    onError: (message) => toast(message, { kind: 'error' }),
    onStatus: (status) => {
      const dot = $('#status-dot');
      dot.dataset.status = status;
      const text = { searching: t('gps.search'), tracking: t('gps.on'), weak: t('gps.weak'), off: t('status.active') }[status] || status;
      $('#status-text').textContent = text;
      $('#gps-toggle').setAttribute('aria-pressed', String(status !== 'off'));
    }
  });
  if (settings.get('input') === 'gps') app.gps.start();
}

function toggleGps() {
  if (app.gps.active) {
    app.gps.stop();
    settings.set('input', 'manual');
  } else {
    settings.set('input', 'gps');
    app.gps.start();
  }
}

// ---------- интересные места и цели ----------

/** @type {{lat: number, lng: number} | null} */
let poiCenter = null;
async function loadPois() {
  const p = app.player;
  if (poiCenter && distance(poiCenter.lat, poiCenter.lng, p.lat, p.lng) < POI_FETCH_RADIUS * 0.6) return;
  poiCenter = { ...p };
  const start = settings.get('start');
  const camp = { id: 'camp', lat: start.lat, lng: start.lng, name: getLang() === 'en' ? 'Base camp' : 'Базовый лагерь', kind: 'camp', discovered: true };
  if (!app.pois.length) {
    app.pois = [camp];
    renderPoiList();
  }
  try {
    const found = await fetchPois(p.lat, p.lng, POI_FETCH_RADIUS);
    const known = new Map(app.pois.map((poi) => [poi.id, poi]));
    found.forEach((poi) => {
      if (!known.has(poi.id)) {
        poi.discovered = Boolean(game.state.pois[poi.id]);
        known.set(poi.id, poi);
      }
    });
    app.pois = [...known.values()];
  } catch (error) {
    if (!app.pois.length) app.pois = [camp];
  }
  checkPois();
  updateMarkers();
}

function checkPois() {
  let changed = false;
  app.pois.forEach((poi) => {
    if (poi.discovered) return;
    if (distance(app.player.lat, app.player.lng, poi.lat, poi.lng) <= DISCOVERY_METERS) {
      poi.discovered = true;
      changed = true;
      if (game.recordPoi(poi)) {
        toast(`${t('pois.found')}: ${poi.name}`, { kind: 'ok' });
        updateLevel();
      }
    }
  });
  renderPoiList(changed);
  if (changed) updateMarkers();
}

/** @param {boolean} [animateNew] */
function renderPoiList(animateNew = false) {
  const list = $('#discovery-list');
  const sorted = app.pois
    .map((poi) => ({ poi, d: distance(app.player.lat, app.player.lng, poi.lat, poi.lng) }))
    .sort((a, b) => Number(b.poi.discovered) - Number(a.poi.discovered) || a.d - b.d)
    .slice(0, 8);
  const previous = new Set([...list.querySelectorAll('li.found')].map((li) => /** @type {HTMLElement} */ (li).dataset.poi));
  list.innerHTML = '';
  sorted.forEach(({ poi, d }) => {
    const li = document.createElement('li');
    li.className = `discovery${poi.discovered ? ' found' : ''}`;
    li.dataset.poi = poi.id;
    const icon = document.createElement('span');
    icon.className = 'discovery-icon';
    icon.textContent = poi.discovered ? (poi.kind === 'camp' ? '⌂' : '✓') : '?';
    const body = document.createElement('span');
    const name = document.createElement('b');
    const small = document.createElement('small');
    const label = poi.discovered ? poi.name : '???';
    small.textContent = poi.discovered ? t('pois.found') : t('pois.distance', { d: formatDistance(d) });
    body.append(name, small);
    li.append(icon, body);
    list.appendChild(li);
    if (animateNew && poi.discovered && !previous.has(poi.id)) typewriter(name, label);
    else name.textContent = label;
  });
  const found = app.pois.filter((p) => p.discovered).length;
  $('#discovery-count').textContent = `${found} / ${app.pois.length}`;
}

function updateMarkers() {
  /** @type {import('./markers.js').MarkerSpec[]} */
  const specs = [];
  app.pois.forEach((poi) => {
    if (!poi.discovered || poi.kind === 'camp') return;
    specs.push({ id: poi.id, lat: poi.lat, lng: poi.lng, html: `<span>✦</span><em>${escapeHtml(poi.name)}</em>`, className: 'marker-poi', label: poi.name, requireRevealed: true });
  });
  app.notes.list().forEach((note) => {
    specs.push({
      id: note.id,
      lat: note.lat,
      lng: note.lng,
      html: note.kind === 'photo' ? '<span>📷</span>' : '<span>⚑</span>',
      className: `marker-${note.kind}`,
      label: note.title || (note.kind === 'photo' ? 'Фото' : 'Метка'),
      requireRevealed: false,
      onClick: () => openPanel(app, 'note', note)
    });
  });
  app.markers.set(specs);
  app.renderer.wards = app.notes
    .list()
    .filter((n) => n.kind === 'flag')
    .map((n) => ({ lat: n.lat, lng: n.lng }));
}

/** @param {string} s */
function escapeHtml(s) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] || c);
}

let nearestTimer = 0;
function updateQuest() {
  const quest = nextQuest(app.pois, app.player.lat, app.player.lng);
  const arrow = $('#quest-arrow');
  if (quest) {
    $('#quest-text').textContent =
      `${quest.poi.discovered ? quest.poi.name : '???'} — ${t('quest.go', { dir: compassDirection(quest.bearing), d: formatDistance(quest.distance) })}`;
    arrow.hidden = false;
    arrow.style.setProperty('--bearing', `${quest.bearing - 90}deg`);
    const p = app.view.project(app.player.lat, app.player.lng);
    arrow.style.left = `${p.x}px`;
    arrow.style.top = `${p.y}px`;
  } else {
    $('#quest-text').textContent = t('quest.none');
    arrow.hidden = true;
  }
  const now = Date.now();
  if (now - nearestTimer > 3000) {
    nearestTimer = now;
    const near = nearestUnexplored(fog, app.player.lat, app.player.lng, settings.get('radius'), 1500);
    $('#nearest-text').textContent = near ? t('hint.nearest', { dir: compassDirection(near.bearing), d: formatDistance(near.distance) }) : '';
  }
  const ch = game.challengeProgress(app.areaCoverage ? app.areaCoverage.revealed : fog.totalCells);
  $('#challenge-text').textContent = ch
    ? `Испытание «${ch.areaName}»: +${ch.gained.toFixed(1)}% из ${ch.targetPercent}% · ${ch.done ? 'выполнено ✓' : ch.expired ? 'время вышло' : `до ${new Date(ch.end).toLocaleDateString()}`}`
    : '';
}

// ---------- прогресс ----------

function updateProgress() {
  let percentage;
  let caption;
  if (app.area && app.areaCoverage) {
    percentage = app.areaCoverage.ratio * 100;
    caption = t('progress.of', { area: app.area.name });
    $('#map-label').textContent = `${t('map.sector')} · ${app.area.name}`;
  } else {
    percentage = Math.min(100, (fog.revealedArea(app.player.lat) / 1e6) * 100);
    caption = t('progress.sector');
  }
  const shown = percentage < 10 ? percentage.toFixed(1) : String(Math.round(percentage));
  $('#progress-bar').style.width = `${percentage}%`;
  $('#progress-value').textContent = `${shown}%`;
  $('#sheet-summary').textContent = `${shown}%`;
  const track = $('#progress-track');
  track.setAttribute('aria-valuenow', shown);
  const phrase = percentage > 70 ? t('progress.late') : percentage > 35 ? t('progress.mid') : t('progress.start');
  $('#progress-caption').textContent = `${phrase} · ${caption}`;
  $('#progress-area').textContent = `${formatArea(fog.revealedArea(app.player.lat))} · ${fog.totalCells.toLocaleString()} кл.`;
  $('#map-name').textContent = t('map.name', { area: app.area ? app.area.name : 'Долина первых следов', radius: settings.get('radius') });
}

function updateLevel() {
  const { level, current, next } = levelFor(game.state.xp);
  $('#level-label').textContent = t('level', { level });
  $('#xp-bar').style.width = `${((game.state.xp - current) / (next - current)) * 100}%`;
  $('#xp-caption').textContent =
    `${t('xp', { xp: game.state.xp.toLocaleString(), next: next.toLocaleString() })} · ${t('today.cells', { today: game.today(), week: game.week() })}`;
  $('#today-value').textContent = `+${game.today()}`;
  const days = Object.keys(game.state.days).length || 1;
  $('#intro-eyebrow').textContent = t('intro.eyebrow', { day: String(days).padStart(2, '0') });
}

function updatePosition() {
  const p = app.player;
  $('#coordinates').textContent = `${Math.abs(p.lat).toFixed(4)}° ${p.lat >= 0 ? 'N' : 'S'}   ${Math.abs(p.lng).toFixed(4)}° ${p.lng >= 0 ? 'E' : 'W'}`;
}

async function loadArea() {
  try {
    const areas = await fetchAreasAt(app.player.lat, app.player.lng);
    const local = areas.find((a) => a.level >= 9) || areas[0] || null;
    app.areas = areas;
    if (local) {
      app.area = local;
      app.areaCoverage = await areaCoverage(fog, local);
      updateProgress();
      updateQuest();
    }
  } catch (error) {
    /* без сети прогресс считается по квадратному километру */
  }
}

function refreshAll() {
  updatePlayerMarker();
  updatePosition();
  updateProgress();
  updateLevel();
  renderPoiList();
  updateQuest();
  app.markers.update();
  app.renderer.requestDraw();
}

// ---------- ввод ----------

function setupInput() {
  document.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const moves = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const dir = moves[/** @type {'w'} */ (key)];
    if (dir) {
      event.preventDefault();
      step(dir[0], dir[1]);
      return;
    }
    /** @type {Record<string, () => void>} */
    const actions = {
      '+': () => app.view.zoomIn(),
      '=': () => app.view.zoomIn(),
      '-': () => app.view.zoomOut(),
      t: () => {
        const themes = ['terra', 'heroes', 'western'];
        const next = themes[(themes.indexOf(settings.get('theme')) + 1) % themes.length];
        settings.set('theme', next);
      },
      m: () => {
        const modes = ['classic', 'heroes4', 'redalert', 'moba', 'hex'];
        const next = modes[(modes.indexOf(settings.get('fogMode')) + 1) % modes.length];
        settings.set('fogMode', next);
        toast(`Режим пелены: ${next}`);
      },
      g: () => toggleGps(),
      c: () => centerOnPlayer(),
      f: () => openPanel(app, 'flag'),
      h: () => settings.set('showHeat', !settings.get('showHeat')),
      r: () => settings.set('showTrack', !settings.get('showTrack')),
      j: () => openPanel(app, 'journal'),
      i: () => openPanel(app, 'stats'),
      o: () => openPanel(app, 'settings'),
      p: () => openPanel(app, 'share'),
      '?': () => openPanel(app, 'help')
    };
    const action = actions[key];
    if (action) {
      event.preventDefault();
      action();
    }
  });
  $('#locate').addEventListener('click', () => {
    const start = settings.get('start');
    movePlayer(start.lat, start.lng, { teleport: true });
    app.view.setView(start.lat, start.lng, 15);
  });
  $('#center-me').addEventListener('click', centerOnPlayer);
  $('#gps-toggle').addEventListener('click', toggleGps);
  $('#zoom-in').addEventListener('click', () => app.view.zoomIn());
  $('#zoom-out').addEventListener('click', () => app.view.zoomOut());
  document
    .querySelectorAll('.theme-button')
    .forEach((button) => button.addEventListener('click', () => settings.set('theme', /** @type {string} */ (/** @type {HTMLElement} */ (button).dataset.theme))));
  const handle = $('#sheet-handle');
  handle.addEventListener('click', () => {
    const open = handle.getAttribute('aria-expanded') !== 'true';
    handle.setAttribute('aria-expanded', String(open));
    $('#side-panel').classList.toggle('expanded', open);
  });
}

function setupSettingsReactions() {
  settings.onChange((key, value) => {
    if (key === 'theme') applyTheme(value);
    if (key === 'ui') document.documentElement.dataset.ui = value;
    if (key === 'night') applyTheme(settings.get('theme'), false);
    if (key === 'lang') {
      setLang(value);
      applyI18n();
      refreshAll();
    }
    if (key === 'basemap') recreateView();
    if (key === 'debug') $('#debug').hidden = !value;
    if (['fogMode', 'showHeat', 'showTrack', 'regrowDays', 'hexMeters', 'visionMeters'].includes(key)) app.renderer.requestDraw();
    if (key === 'radius') updateProgress();
    if (key === 'input') {
      if (value === 'gps' && !app.gps.active) app.gps.start();
      if (value === 'manual' && app.gps.active) app.gps.stop();
    }
  });
}

// ---------- служебное ----------

function setupDebugAndLoading() {
  setInterval(() => {
    const loading = fog.loading.size > 0 || (app.renderer && app.renderer.stats.pending > 0);
    $('#loading').hidden = !loading;
    if (settings.get('debug') && app.renderer) {
      const s = app.renderer.stats;
      $('#debug').textContent =
        `кадр ${s.frameMs.toFixed(2)} мс (ср. ${s.avgMs.toFixed(2)})\nчанков на экране ${s.chunks}\nв памяти ${fog.chunks.size} / в индексе ${fog.index.size}\n` +
        `кэш картинок ${s.cache}, ждут ${s.pending}\nкадров ${s.draws}\nGPS отброшено: ${JSON.stringify(app.gps ? app.gps.rejected : {})}`;
    }
  }, 400);
}

function clock() {
  $('#clock').textContent = new Date().toLocaleTimeString(getLang() === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* без офлайн-режима */
  });
}

// ---------- запуск ----------

async function boot() {
  document.documentElement.dataset.ui = settings.get('ui');
  if (new URLSearchParams(location.search).has('debug')) settings.set('debug', true);
  $('#debug').hidden = !settings.get('debug');
  await fog.ready;
  if (fog.error) toast(fog.error.message, { kind: 'error', duration: 12000 });
  fog.on('error', (/** @type {Error} */ error) => toast(error.message, { kind: 'error', duration: 12000 }));
  app.tracks = new TrackStore(fog.db);
  app.notes = new NotesStore(fog.db);
  await Promise.all([app.tracks.ready, app.notes.ready]);

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
  } catch (error) {
    saved = null;
  }
  app.view = await createView(saved);
  app.renderer = new FogRenderer({
    view: app.view,
    fog,
    viewport: $('#map-viewport'),
    canvas: /** @type {HTMLCanvasElement} */ ($('#fog-canvas')),
    overlay: /** @type {HTMLCanvasElement} */ ($('#overlay-canvas')),
    getTheme: () => settings.get('theme'),
    getMode: () => settings.get('fogMode'),
    getSettings: () => settings.data
  });
  app.renderer.getTracks = () => app.tracks.allSegments();
  app.markers = new MarkerLayer($('#marker-layer'), app.view, (lat, lng) => fog.isRevealed(lat, lng));
  wireView();
  try {
    app.minimap = new Minimap($('#minimap'), app.view, fog);
  } catch (error) {
    app.minimap = null;
  }
  fog.on('loaded', () => {
    app.renderer.requestDraw();
    app.markers.update();
  });
  fog.on('external', () => {
    updateProgress();
    app.renderer.requestDraw();
  });
  fog.on('saved', () => {
    $('#saved-at').textContent = t('saved', { time: new Date().toLocaleTimeString() });
  });
  game.onAchievement.push((a) => toast(t('achievement', { name: `${a.icon} ${getLang() === 'en' ? a.nameEn : a.name}` }), { kind: 'achievement', duration: 7000 }));
  window.addEventListener('resize', () => {
    app.view.invalidate();
    app.renderer.requestDraw();
  });
  matchMedia('(resolution: 1dppx)').addEventListener('change', () => app.renderer.requestDraw());

  setupInput();
  setupSettingsReactions();
  setupPanels(app);
  setupGps();
  setupDebugAndLoading();
  applyTheme(settings.get('theme'), false);
  $('#saved-at').textContent = fog.totalCells ? t('saved.loaded', { n: fog.index.size }) : t('saved.never');
  clock();
  setInterval(clock, 30000);
  setInterval(() => applyTheme(settings.get('theme'), false), 10 * 60000);

  await revealAt(app.player.lat, app.player.lng, settings.get('radius'), { animate: false });
  refreshAll();
  updateMarkers();
  loadPois().then(updateQuest);
  loadArea();
  registerServiceWorker();
  if (!settings.get('onboarded')) showOnboarding(app);
  document.documentElement.dataset.ready = 'true';
  void dayKey;
}

boot().catch((error) => {
  console.error(error);
  toast(`Не удалось запустить карту: ${error.message}`, { kind: 'error', duration: 0 });
});
