/** Всплывающие уведомления: список живёт в сигнале, рисует его <Toasts/> в App.tsx. */
import { ui, type ToastItem } from './model.ts';

let nextId = 1;

export function dismissToast(id: number): void {
  ui.toasts.update((list) => list.filter((item) => item.id !== id));
}

export function toast(message: string, options: { kind?: ToastItem['kind']; duration?: number; action?: ToastItem['action'] } = {}): number {
  const id = nextId++;
  ui.toasts.update((list) => [...list, { id, kind: options.kind || 'info', message, action: options.action }]);
  const duration = options.duration ?? (options.action ? 9000 : 4000);
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}
