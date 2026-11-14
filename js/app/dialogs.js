// Toasts, the shared dialog, form helpers and autosaving forms.
'use strict';

// ----- toasts and dialogs -----
/** Fills `parent` with text in which `[label](target)` is a link: a page path (`/p/x/w/y`) or `node:ID` (selects that node on the canvas). Everything else is plain text. */
function linkedText(parent, message) {
  const parts = String(message).split(/(\[[^\]]+\]\([^)\s]+\))/);
  for (const part of parts) {
    const match = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (!match) {
      parent.append(part);
      continue;
    }
    const [, label, target] = match;
    if (target.startsWith('node:')) {
      const button = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'link',
        textContent: label,
      });
      button.onclick = () => reveal(target.slice(5));
      parent.append(button);
    } else {
      const link = Object.assign(document.createElement('a'), {textContent: label, href: '#' + target});
      link.setAttribute('data-link', '');
      parent.append(link);
    }
  }
}

/** A notification. Its text may hold links (see `linkedText`); following one dismisses it. */
function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = 'toast' + (error ? ' error' : '');
  item.setAttribute('role', error ? 'alert' : 'status');
  const text = document.createElement('span');
  linkedText(text, message);
  text.addEventListener('click', event => event.target.closest('a, button') && item.remove());
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = icon('x');
  close.onclick = () => item.remove();
  item.append(text, close);
  $('#toasts').append(item);
  setTimeout(() => item.remove(), error ? 8000 : 3500);
}
const fail = error => toast(error.message || String(error), true);

/** Opens the shared dialog. `submit` receives the form; returning false keeps the dialog open. */
function dialog(title, body, submit, label = 'Save', danger = false) {
  const modal = $('#modal');
  $('#modal-form').onchange = $('#modal-form').oninput = $('#modal-form').onclick = null;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-error').hidden = true;
  $('#modal-actions').innerHTML = submit
    ? `<button type="button" value="cancel" class="ghost">Cancel</button><button type="submit" value="ok" class="${danger ? 'danger' : 'primary'}">${esc(label)}</button>`
    : '';
  modal.onsubmit = async event => {
    if (event.submitter?.value === 'cancel' || !submit) return;
    event.preventDefault();
    const button = event.submitter || $('#modal-actions button[value=ok]');
    button.disabled = true;
    try {
      if ((await submit($('#modal-form'))) !== false) modal.close();
    } catch (error) {
      $('#modal-error').textContent = error.message;
      $('#modal-error').hidden = false;
    } finally {
      button.disabled = false;
    }
  };
  modal.showModal();
  let backdropDown = false;
  const outside = event => {
    // A drop-down list opened inside the dialog may reach past its edge; clicking it is not clicking outside.
    if (event.target.closest?.('.popup')) return false;
    const r = modal.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  modal.onpointerdown = event => {
    backdropDown = outside(event);
  };
  modal.onclick = event => {
    if (event.target.closest('button[value=cancel]')) return modal.close('cancel');
    if (backdropDown && outside(event)) modal.close();
    backdropDown = false;
  };
  $('[autofocus]', modal)?.focus();
}
const confirmDialog = (title, text, action, label) =>
  dialog(title, `<p class="muted">${esc(text)}</p>`, action, label, true);
const field = (label, control, help = '') => {
  const tag = control.includes('data-icon-grid') ? 'div' : 'label';
  return `<${tag} class="field"${help ? ` title="${esc(help)}"` : ''}><span>${esc(label)}</span>${control}</${tag}>`;
};
const options = (items, selected) =>
  items
    .map(
      ([value, label]) =>
        `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`
    )
    .join('');

// Serialize autosaves and capture each edit before a later render can replace its form.
function autoForm(form, read, write) {
  let timer,
    chain = Promise.resolve(),
    inflight = 0,
    saved;
  try {
    saved = JSON.stringify(read());
  } catch {
    /* incomplete new form */
  }
  const status = document.createElement('small');
  status.className = 'save-status muted';
  status.setAttribute('role', 'status');
  form.append(status);
  const flush = () => {
    clearTimeout(timer);
    let data;
    try {
      if (!form.checkValidity()) {
        if (!flush.isDirty()) return chain;
        status.textContent = 'Complete the highlighted fields';
        return Promise.resolve(false);
      }
      data = read();
    } catch (error) {
      status.textContent = error.message;
      return Promise.resolve(false);
    }
    const key = JSON.stringify(data);
    if (key === saved) return chain;
    saved = key;
    status.classList.remove('bad');
    status.textContent = 'Saving…';
    inflight++;
    chain = chain
      .then(() => write(data))
      .then(
        () => {
          inflight--;
          status.textContent = 'Saved';
          return true;
        },
        error => {
          inflight--;
          saved = undefined;
          status.textContent = error.message;
          status.classList.add('bad');
          fail(error);
          return false;
        }
      );
    return chain;
  };
  const changed = event => {
    if (event?.target.closest('#node-connections, .conn-host, .port-conn')) return;
    clearTimeout(timer);
    status.textContent = 'Unsaved changes';
    timer = setTimeout(flush, event?.type === 'change' ? 60 : 400);
  };
  form.addEventListener('input', changed);
  form.addEventListener('change', changed);
  form.onsubmit = event => {
    event.preventDefault();
    flush();
  };
  return Object.assign(flush, {
    changed,
    // Dirty while a save is still on its way too: a render from the data before it would drop the edit.
    isDirty: () => {
      if (inflight) return true;
      try {
        return JSON.stringify(read()) !== saved;
      } catch {
        return true;
      }
    },
  });
}
/** An invalid field or failed save offers a visible choice instead of silently losing edits or trapping navigation. */
async function leaveAutosave(save) {
  if ((await save()) !== false) return true;
  return new Promise(resolve => {
    dialog(
      'Unsaved changes',
      '<p>Some changes could not be saved. Stay here to correct them, or discard them and leave.</p>',
      () => resolve(true),
      'Discard changes',
      true
    );
    $('#modal').addEventListener('close', () => resolve(false), {once: true});
  });
}
