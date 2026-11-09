/**
 * Модальные окна на <dialog>: фокус уходит внутрь и возвращается обратно, Esc закрывает.
 * Содержимое строится в собственной области владения Svet и освобождается при закрытии.
 */
import { createRoot, signal } from 'svet-engine';
import { tr } from './model.ts';

export interface DialogAction {
  label: string | (() => string);
  kind?: string;
  /** true — не закрывать окно */
  run?: () => void | boolean | Promise<void | boolean>;
}

export interface DialogOptions {
  title: string | (() => string);
  body: () => Node;
  wide?: boolean;
  actions?: DialogAction[];
  onClose?: () => void;
}

let dialogSeq = 0;

export function openDialog(options: DialogOptions): HTMLDialogElement {
  const previous = document.activeElement as HTMLElement | null;
  const headingId = `dlg-${++dialogSeq}`;
  let dispose = () => {};
  const dialog = createRoot((disposeRoot) => {
    dispose = disposeRoot;
    const actions = options.actions || [{ label: tr('close') }];
    // обработчики читают el уже после сборки, поэтому отдельный ref не нужен
    const el: HTMLDialogElement = (
      <dialog class={`modal${options.wide ? ' modal-wide' : ''}`} aria-labelledby={headingId}>
        <button type="button" class="modal-x" aria-label={tr('close')} onClick={() => el.close()}>
          ×
        </button>
        <h2 id={headingId}>{options.title}</h2>
        <div class="modal-body">{options.body()}</div>
        <div class="modal-actions">
          {actions.map((action) => (
            <button
              type="button"
              class={`btn ${action.kind || ''}`}
              onClick={async () => {
                const keep = action.run ? await action.run() : false;
                if (keep !== true) el.close();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </dialog>
    ) as HTMLDialogElement;
    return el;
  });
  dialog.addEventListener('close', () => {
    dispose();
    dialog.remove();
    if (options.onClose) options.onClose();
    if (previous && previous.focus) previous.focus();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

/** Подтверждение опасного действия вводом слова. */
export function confirmTyped(options: { title: string; text: string; word: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const typed = signal('');
    const invalid = signal(false);
    let input!: HTMLInputElement;
    openDialog({
      title: options.title,
      body: () => (
        <div>
          <p>{options.text}</p>
          <label class="field">
            <input
              type="text"
              autocomplete="off"
              aria-label={options.word}
              aria-invalid={() => (invalid() ? 'true' : false)}
              model={typed}
              ref={(el: HTMLInputElement) => (input = el)}
            />
          </label>
        </div>
      ),
      actions: [
        { label: tr('cancel') },
        {
          label: tr('confirm'),
          kind: 'danger',
          run: () => {
            if (typed.peek().trim().toLowerCase() !== options.word) {
              invalid.set(true);
              input.focus();
              return true;
            }
            ok = true;
            return false;
          }
        }
      ],
      onClose: () => resolve(ok)
    });
    input.focus();
  });
}
