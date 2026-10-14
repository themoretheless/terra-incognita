// @ts-check
/**
 * Модальные окна на <dialog>: фокус уходит внутрь и возвращается обратно,
 * Esc закрывает. Подтверждение опасных действий — вводом слова.
 */
import { t } from '../i18n.js';

/**
 * @param {{ title: string, body: Node | string, wide?: boolean, actions?: Array<{ label: string, kind?: string, run?: () => void | boolean | Promise<void | boolean> }>, onClose?: () => void }} options
 * @returns {HTMLDialogElement}
 */
export function openDialog(options) {
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  const dialog = document.createElement('dialog');
  dialog.className = `modal${options.wide ? ' modal-wide' : ''}`;
  const heading = document.createElement('h2');
  heading.textContent = options.title;
  heading.id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const content = document.createElement('div');
  content.className = 'modal-body';
  if (typeof options.body === 'string') content.textContent = options.body;
  else content.appendChild(options.body);
  const footer = document.createElement('div');
  footer.className = 'modal-actions';
  const actions = options.actions || [{ label: t('close') }];
  actions.forEach((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${action.kind || ''}`;
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      const keep = action.run ? await action.run() : false;
      if (keep !== true) dialog.close();
    });
    footer.appendChild(button);
  });
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'modal-x';
  x.setAttribute('aria-label', t('close'));
  x.textContent = '×';
  x.addEventListener('click', () => dialog.close());
  dialog.append(x, heading, content, footer);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (options.onClose) options.onClose();
    if (previous && previous.focus) previous.focus();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  return dialog;
}

/**
 * Подтверждение вводом слова.
 * @param {{ title: string, text: string, word: string }} options
 * @returns {Promise<boolean>}
 */
export function confirmTyped(options) {
  return new Promise((resolve) => {
    let ok = false;
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = options.text;
    const label = document.createElement('label');
    label.className = 'field';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', options.word);
    label.append(input);
    wrap.append(p, label);
    const dialog = openDialog({
      title: options.title,
      body: wrap,
      actions: [
        { label: t('cancel') },
        {
          label: t('confirm'),
          kind: 'danger',
          run: () => {
            if (input.value.trim().toLowerCase() !== options.word) {
              input.setAttribute('aria-invalid', 'true');
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
    void dialog;
    input.focus();
  });
}
