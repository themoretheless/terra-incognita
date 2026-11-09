/** Общая обвязка для Forma-компонентов: язык из модели, события, освобождение. */
import { effect, onCleanup, type FormaRuntimeInstance, type FormaSlotMap, type Signal } from 'svet-engine';
import { ui } from './model.ts';

type Factory = (options?: { viewModel?: Record<string, Signal<any>>; locale?: string; slots?: FormaSlotMap }) => FormaRuntimeInstance;

/**
 * Создаёт экземпляр `.ui`-компонента внутри текущей области владения Svet.
 * Возвращает готовый DOM-фрагмент; язык следует за ui.locale.
 */
export function formaView(
  create: Factory,
  options: {
    viewModel?: Record<string, Signal<any>>;
    slots?: Record<string, Node>;
    events?: Record<string, (...args: any[]) => void>;
  } = {}
): DocumentFragment {
  const instance = create({
    viewModel: options.viewModel,
    locale: ui.locale.peek(),
    slots: options.slots ? { namedSlots: options.slots } : undefined
  });
  Object.entries(options.events || {}).forEach(([name, handler]) => instance.onEvent(name, handler));
  effect(() => {
    instance.locale.set(ui.locale());
  });
  const fragment = instance.render();
  onCleanup(() => instance.dispose());
  return fragment;
}
