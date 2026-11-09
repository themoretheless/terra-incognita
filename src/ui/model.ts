/**
 * Модель представления: сигналы Svet, которые пишет оркестратор (main.js)
 * и читают компоненты — и JSX, и Forma `.ui` (через viewModel).
 */
import { signal, type Signal } from 'svet-engine/slim';
import { t } from '../i18n.js';

export interface PoiRow {
  /** ключ строки: меняется вместе с содержимым, чтобы <For> перерисовал её */
  key: string;
  id: string;
  icon: string;
  name: string;
  note: string;
  found: boolean;
  /** только что найдено — имя «дописывается» */
  fresh: boolean;
}

export interface ToastItem {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'error' | 'achievement';
  message: string;
  action?: { label: string; run: () => void };
}

export const ui = {
  locale: signal('ru'),
  theme: signal('terra'),

  statusKind: signal('off'),
  statusText: signal(''),
  clock: signal(''),
  eyebrow: signal(''),

  mapLabel: signal(''),
  mapName: signal(''),
  zoomLabel: signal(''),
  gpsActive: signal(false),
  loading: signal(false),
  debugVisible: signal(false),
  debugText: signal(''),
  playerTransform: signal('translate(0px, 0px)'),
  questVisible: signal(false),
  questBearing: signal(0),

  progressShown: signal('0'),
  progressWidth: signal('0%'),
  progressCaption: signal(''),
  progressArea: signal(''),
  levelLabel: signal(''),
  todayText: signal('+0'),
  xpWidth: signal('0%'),
  xpCaption: signal(''),
  questText: signal('—'),
  nearestText: signal(''),
  challengeText: signal(''),
  coordinates: signal('—'),
  pois: signal<PoiRow[]>([]),
  discoveryCount: signal('0 / 0'),
  savedAt: signal('…'),
  sheetExpanded: signal(false),

  toasts: signal<ToastItem[]>([])
};

export type UiModel = typeof ui;

/** Реактивный перевод для JSX: перечитывается при смене языка. */
export function tr(key: string, params?: Record<string, string | number>): () => string {
  return () => {
    ui.locale();
    return t(key, params);
  };
}

/** Двуязычная строка без словаря — для редких подписей. */
export function L(ru: string, en: string): () => string {
  return () => (ui.locale() === 'en' ? en : ru);
}

/** Текущее значение двуязычной строки вне реактивного контекста. */
export function l(ru: string, en: string): string {
  return ui.locale.peek() === 'en' ? en : ru;
}

export type { Signal };
