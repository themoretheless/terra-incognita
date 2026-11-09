/**
 * Оболочка приложения на Svet. Семантическая разметка, ориентиры и ARIA — здесь;
 * декларативные области (меню, стили, сводка) — Forma-компоненты из ./views.
 * Карта, canvas пелены и слой маркеров остаются узлами, которыми управляют
 * императивные модули (Leaflet, FogRenderer, MarkerLayer).
 */
import { For, effect } from 'svet-engine';
import { ui, tr, L } from './model.ts';
import { formaView } from './forma.ts';
import { dismissToast } from './toast.ts';
import createTopMenu from './views/TopMenu.ui';
import createThemeSwitcher from './views/ThemeSwitcher.ui';
import createSidePanel from './views/SidePanel.ui';

export interface AppActions {
  openPanel(name: string): void;
  pickTheme(theme: string): void;
  toggleGps(): void;
  centerOnPlayer(): void;
  zoomIn(): void;
  zoomOut(): void;
  locate(): void;
}

function Toasts(): Node {
  return (
    <div class="toasts" role="status" aria-live="polite">
      <For each={ui.toasts} keyFn={(item) => item.id}>
        {(item) => (
          <div class={`toast toast-${item.kind}`}>
            <span>{item.message}</span>
            {item.action ? (
              <button
                type="button"
                onClick={() => {
                  item.action!.run();
                  dismissToast(item.id);
                }}
              >
                {item.action.label}
              </button>
            ) : null}
            <button type="button" class="toast-close" aria-label={tr('close')} onClick={() => dismissToast(item.id)}>
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

/** «Дописывание» названия только что найденного места. */
function typeFreshNames(root: HTMLElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll<HTMLElement>('[data-part="poi"][data-fresh="true"] [data-part="poi-name"]').forEach((el) => {
    if (el.dataset.typed) return;
    el.dataset.typed = '1';
    const text = el.textContent || '';
    let n = 0;
    const tick = () => {
      if (!el.isConnected) return;
      n += 1;
      el.textContent = text.slice(0, n);
      if (n < text.length) setTimeout(tick, 18);
    };
    tick();
  });
}

export function App(props: { actions: AppActions }): Node {
  const { actions } = props;
  const minimap = <div class="minimap" id="minimap" aria-hidden="true"></div>;
  let side!: HTMLElement;

  const view = (
    <>
      <a class="skip-link" href="#map-viewport">
        {L('К карте', 'Skip to map')}
      </a>
      <main class="app-shell">
        <header class="topbar">
          <a class="brand" href="#" aria-label="Terra Incognita">
            <span class="brand-mark" aria-hidden="true">
              ✦
            </span>
            <span>
              terra <em>incognita</em>
            </span>
          </a>
          <nav class="menu" aria-label={L('Меню', 'Menu')}>
            {formaView(createTopMenu, { events: { open: (name: string) => actions.openPanel(name) } })}
          </nav>
          <div class="topbar-meta">
            <span class="status-dot" id="status-dot" aria-hidden="true" data-status={ui.statusKind}></span>
            <span id="status-text">{ui.statusText}</span>
            <span class="divider" aria-hidden="true"></span>
            <span id="clock">{ui.clock}</span>
          </div>
        </header>

        <nav class="theme-switcher" aria-label={L('Стиль карты', 'Map style')}>
          {formaView(createThemeSwitcher, { viewModel: { theme: ui.theme }, events: { pick: (theme: string) => actions.pickTheme(theme) } })}
        </nav>

        <section class="intro">
          <p class="eyebrow">{ui.eyebrow}</p>
          <h1>
            <span>{tr('intro.title1')}</span>
            <br />
            <span class="dim">{tr('intro.title2')}</span>
          </h1>
          <p class="intro-copy">{tr('intro.copy')}</p>
        </section>

        <section class="map-layout" aria-label={L('Карта экспедиции', 'Expedition map')}>
          <div class="map-card">
            <div class="map-toolbar">
              <div class="map-title">
                <span class="map-label">{ui.mapLabel}</span>
                <span class="map-name">{ui.mapName}</span>
              </div>
              <div class="map-controls">
                <button id="gps-toggle" class="chip-button" type="button" aria-pressed={() => String(ui.gpsActive())} onClick={() => actions.toggleGps()}>
                  GPS
                </button>
                <button id="center-me" class="icon-button" type="button" aria-label={tr('center')} title={tr('center')} onClick={() => actions.centerOnPlayer()}>
                  ⌖
                </button>
                <button id="zoom-out" class="icon-button" type="button" aria-label={tr('map.zoomOut')} onClick={() => actions.zoomOut()}>
                  −
                </button>
                <span id="zoom-level" aria-live="polite">
                  {ui.zoomLabel}
                </span>
                <button id="zoom-in" class="icon-button" type="button" aria-label={tr('map.zoomIn')} onClick={() => actions.zoomIn()}>
                  +
                </button>
              </div>
            </div>
            <div class="map-viewport" id="map-viewport" tabindex="-1">
              <div id="map" role="application" aria-label={tr('map.aria')}></div>
              <canvas class="overlay-canvas" id="overlay-canvas" aria-hidden="true"></canvas>
              <canvas class="fog-canvas" id="fog-canvas" aria-hidden="true"></canvas>
              <div class="marker-layer" id="marker-layer"></div>
              <div class="player" id="player" role="img" aria-label={L('Ваш исследователь', 'Your explorer')} style={{ transform: ui.playerTransform }}>
                <span class="player-aura"></span>
                <span class="player-icon">✦</span>
                <span class="quest-arrow" aria-hidden="true" hidden={() => !ui.questVisible()} style={{ '--bearing': () => `${ui.questBearing()}deg` }}>
                  ➤
                </span>
              </div>
              <div class="loading" id="loading" hidden={() => !ui.loading()}>
                <span class="spinner" aria-hidden="true"></span>
                <span>{tr('loading.chunks')}</span>
              </div>
              <pre class="debug" id="debug" hidden={() => !ui.debugVisible()}>
                {ui.debugText}
              </pre>
              <div class="map-hint">
                <span aria-hidden="true">✦</span> <span>{tr('map.hint')}</span> <kbd>W</kbd>
                <kbd>A</kbd>
                <kbd>S</kbd>
                <kbd>D</kbd>
              </div>
            </div>
          </div>

          <aside
            class={() => `side-panel${ui.sheetExpanded() ? ' expanded' : ''}`}
            id="side-panel"
            aria-label={L('Сводка экспедиции', 'Expedition summary')}
            ref={(el: HTMLElement) => (side = el)}
          >
            <button
              class="sheet-handle"
              id="sheet-handle"
              type="button"
              aria-expanded={() => String(ui.sheetExpanded())}
              aria-controls="side-panel"
              onClick={() => ui.sheetExpanded.update((open) => !open)}
            >
              <span aria-hidden="true"></span>
              <b>{() => `${ui.progressShown()}%`}</b>
            </button>
            {formaView(createSidePanel, {
              viewModel: {
                progressShown: ui.progressShown,
                progressWidth: ui.progressWidth,
                progressCaption: ui.progressCaption,
                progressArea: ui.progressArea,
                levelLabel: ui.levelLabel,
                todayText: ui.todayText,
                xpWidth: ui.xpWidth,
                xpCaption: ui.xpCaption,
                questText: ui.questText,
                nearestText: ui.nearestText,
                challengeText: ui.challengeText,
                coordinates: ui.coordinates,
                pois: ui.pois,
                discoveryCount: ui.discoveryCount
              },
              slots: { minimap },
              events: { locate: () => actions.locate() }
            })}
          </aside>
        </section>
        <footer>
          <span>{L('Сохраняйте любопытство.', 'Stay curious.')}</span>
          <span id="saved-at">{ui.savedAt}</span>
        </footer>
      </main>
      <Toasts />
    </>
  );

  effect(() => {
    ui.pois();
    queueMicrotask(() => typeFreshNames(side));
  });
  return view;
}
